import { ALL_PERMISSION_PROPS } from 'app/common/ACLPermissions';
import { ACLRuleCollection, SPECIAL_RULES_TABLE_ID } from 'app/common/ACLRuleCollection';
import { ActionGroup } from 'app/common/ActionGroup';
import { createEmptyActionSummary } from 'app/common/ActionSummary';
import { ServerQuery } from 'app/common/ActiveDocAPI';
import { ApiError } from 'app/common/ApiError';
import {
  AddRecord,
  BulkAddRecord,
  BulkColValues,
  BulkRemoveRecord,
  BulkUpdateRecord,
} from 'app/common/DocActions';
import { RemoveRecord, ReplaceTableData, UpdateRecord } from 'app/common/DocActions';
import { CellValue, ColValues, DocAction, getTableId, isSchemaAction } from 'app/common/DocActions';
import { TableDataAction, UserAction } from 'app/common/DocActions';
import { DocData } from 'app/common/DocData';
import { UserOverride } from 'app/common/DocListAPI';
import { DocUsageSummary, FilteredDocUsageSummary } from 'app/common/DocUsage';
import { normalizeEmail } from 'app/common/emails';
import { ErrorWithCode } from 'app/common/ErrorWithCode';
import { AclMatchInput, InfoEditor, InfoView } from 'app/common/GranularAccessClause';
import { UserInfo } from 'app/common/GranularAccessClause';
import * as gristTypes from 'app/common/gristTypes';
import { getSetMapValue, isNonNullish, pruneArray } from 'app/common/gutil';
import { SingleCell } from 'app/common/TableData';
import { canEdit, canView, isValidRole, Role } from 'app/common/roles';
import { FullUser, UserAccessData } from 'app/common/UserAPI';
import { HomeDBManager } from 'app/gen-server/lib/HomeDBManager';
import { GristObjCode } from 'app/plugin/GristData';
import { compileAclFormula } from 'app/server/lib/ACLFormula';
import { DocClients } from 'app/server/lib/DocClients';
import { getDocSessionAccess, getDocSessionAltSessionId, getDocSessionUser,
         OptDocSession } from 'app/server/lib/DocSession';
import { DocStorage } from 'app/server/lib/DocStorage';
import log from 'app/server/lib/log';
import { IPermissionInfo, PermissionInfo, PermissionSetWithContext } from 'app/server/lib/PermissionInfo';
import { TablePermissionSetWithContext } from 'app/server/lib/PermissionInfo';
import { integerParam } from 'app/server/lib/requestUtils';
import { getRelatedRows, getRowIdsFromDocAction } from 'app/server/lib/RowAccess';
import cloneDeep = require('lodash/cloneDeep');
import fromPairs = require('lodash/fromPairs');
import get = require('lodash/get');

// tslint:disable:no-bitwise

// Actions that add/update/remove/replace rows (DocActions only - UserActions
// may also result in row changes but are not in this list).
const ACTION_WITH_TABLE_ID = new Set(['AddRecord', 'BulkAddRecord', 'UpdateRecord', 'BulkUpdateRecord',
                                      'RemoveRecord', 'BulkRemoveRecord',
                                      'ReplaceTableData', 'TableData',
                                    ]);
type DataAction = AddRecord | BulkAddRecord | UpdateRecord | BulkUpdateRecord |
  RemoveRecord | BulkRemoveRecord | ReplaceTableData | TableDataAction;

// Check if action adds/updates/removes/replaces rows.
function isDataAction(a: UserAction): a is DataAction {
  return ACTION_WITH_TABLE_ID.has(String(a[0]));
}

function isAddRecordAction(a: DataAction): a is AddRecord | BulkAddRecord {
  return ['AddRecord', 'BulkAddRecord'].includes(a[0]);
}

function isRemoveRecordAction(a: DataAction): a is RemoveRecord | BulkRemoveRecord {
  return ['RemoveRecord', 'BulkRemoveRecord'].includes(a[0]);
}

function isBulkAction(a: DataAction): a is BulkAddRecord | BulkUpdateRecord |
  BulkRemoveRecord | ReplaceTableData | TableDataAction {
  return Array.isArray(a[2]);
}

// Check if a tableId is that of an ACL table.  Currently just _grist_ACLRules and
// _grist_ACLResources are accepted.
function isAclTable(tableId: string): boolean {
  return ['_grist_ACLRules', '_grist_ACLResources'].includes(tableId);
}

// A list of key metadata tables that need special handling.  Other metadata tables may
// refer to material in some of these tables but don't need special handling.
// TODO: there are other metadata tables that would need access control, or redesign -
// specifically _grist_Attachments.
const STRUCTURAL_TABLES = new Set(['_grist_Tables', '_grist_Tables_column', '_grist_Views',
                                   '_grist_Views_section', '_grist_Views_section_field',
                                   '_grist_ACLResources', '_grist_ACLRules']);

// Actions that won't be allowed (yet) for a user with nuanced access to a document.
// A few may be innocuous, but generally I've put them in this list if there are problems
// tracking down what table the refer to, or they could allow creation/modification of a
// formula, and are not handled elsewhere.
const SPECIAL_ACTIONS = new Set(['InitNewDoc',
                                 'EvalCode',
                                 'UpdateSummaryViewSection',
                                 'DetachSummaryViewSection',
                                 'GenImporterView',
                                 'TransformAndFinishImport',
                                 'AddView',
                                 'CopyFromColumn',
                                 'ConvertFromColumn',
                                 'AddHiddenColumn',
                                ]);

// Odd-ball actions marked as deprecated or which seem unlikely to be used.
const SURPRISING_ACTIONS = new Set([
                                    'RemoveView',
                                    'AddViewSection',
                                   ]);

// Actions we'll allow unconditionally for now.
const OK_ACTIONS = new Set(['Calculate', 'UpdateCurrentTime']);

interface DocUpdateMessage {
  actionGroup: ActionGroup;
  docActions: DocAction[];
  docUsage: DocUsageSummary;
}

/**
 * Granular access for a single bundle, in different phases.
 */
export interface GranularAccessForBundle {
  canApplyBundle(): Promise<void>;
  appliedBundle(): Promise<void>;
  finishedBundle(): Promise<void>;
  sendDocUpdateForBundle(actionGroup: ActionGroup, docUsage: DocUsageSummary): Promise<void>;
}

/**
 *
 * Manage granular access to a document.  This allows nuances other than the coarse
 * owners/editors/viewers distinctions.  Nuances are stored in the _grist_ACLResources
 * and _grist_ACLRules tables.
 *
 * When the document is being modified, the object's GranularAccess is called at various
 * steps of the process to check access rights.  The GranularAccess object stores some
 * state for an in-progress modification, to allow some caching of calculations across
 * steps and clients.  We expect modifications to be serialized, and the following
 * pattern of calls for modifications:
 *
 *  - assertCanMaybeApplyUserActions(), called with UserActions for an initial access check.
 *    Since not all checks can be done without analyzing UserActions into DocActions,
 *    it is ok for this call to pass even if a more definitive test later will fail.
 *  - getGranularAccessForBundle(), called once a possible bundle has been prepared
 *    (the UserAction has been compiled to DocActions).
 *  - canApplyBundle(), called when DocActions have been produced from UserActions,
 *    but before those DocActions have been applied to the DB.  If fails, the modification
 *    will be abandoned.
 *  - appliedBundle(), called when DocActions have been applied to the DB, but before
 *    those changes have been sent to clients.
 *  - sendDocUpdateforBundle() is called once a bundle has been applied, to notify
 *    client of changes.
 *  - finishedBundle(), called when completely done with modification and any needed
 *    client notifications, whether successful or failed.
 *
 *
 */
export class GranularAccess implements GranularAccessForBundle {
  // The collection of all rules.
  private _ruler = new Ruler(this);

  // Cache of user attributes associated with the given docSession. It's a WeakMap, to allow
  // garbage-collection once docSession is no longer in use.
  private _userAttributesMap = new WeakMap<OptDocSession, UserAttributes>();
  private _prevUserAttributesMap: WeakMap<OptDocSession, UserAttributes>|undefined;

  // When broadcasting a sequence of DocAction[]s, this contains the state of
  // affected rows for the relevant table before and after each DocAction.  It
  // may contain some unaffected rows as well.
  private _steps: Promise<ActionStep[]>|null = null;
  // Intermediate metadata and rule state, if needed.
  private _metaSteps: Promise<MetaStep[]>|null = null;
  // Access control is done sequentially, bundle by bundle.  This is the current bundle.
  private _activeBundle: {
    docSession: OptDocSession,
    userActions: UserAction[],
    docActions: DocAction[],
    isDirect: boolean[],
    undo: DocAction[],
    // Flag tracking whether a set of actions have been applied to the database or not.
    applied: boolean,
    // Flag for whether user actions mention a rule change (clients are asked to reload
    // in this case).
    hasDeliberateRuleChange: boolean,
    // Flag for whether doc actions mention a rule change, even if passive due to
    // schema changes.
    hasAnyRuleChange: boolean,
  }|null;

  public constructor(
    private _docData: DocData,
    private _docStorage: DocStorage,
    private _docClients: DocClients,
    private _fetchQueryFromDB: (query: ServerQuery) => Promise<TableDataAction>,
    private _recoveryMode: boolean,
    private _homeDbManager: HomeDBManager | null,
    private _docId: string) {
  }

  public getGranularAccessForBundle(docSession: OptDocSession, docActions: DocAction[], undo: DocAction[],
                                    userActions: UserAction[], isDirect: boolean[]): void {
    if (this._activeBundle) { throw new Error('Cannot start a bundle while one is already in progress'); }
    // This should never happen - attempts to write to a pre-fork session should be
    // caught by an Authorizer.  But let's be paranoid, since we may be pretending to
    // be an owner for granular access purposes, and owners can write if we're not
    // careful!
    if (docSession.forkingAsOwner) { throw new Error('Should never modify a prefork'); }
    this._activeBundle = {
      docSession, docActions, undo, userActions, isDirect,
      applied: false, hasDeliberateRuleChange: false, hasAnyRuleChange: false
    };
    this._activeBundle.hasDeliberateRuleChange =
      scanActionsRecursively(userActions, (a) => isAclTable(String(a[1])));
    this._activeBundle.hasAnyRuleChange =
      scanActionsRecursively(docActions, (a) => isAclTable(String(a[1])));
  }

  /**
   * Update granular access from DocData.
   */
  public async update() {
    await this._ruler.update(this._docData);

    // Also clear the per-docSession cache of user attributes.
    this._userAttributesMap = new WeakMap();
  }

  public getUser(docSession: OptDocSession): Promise<UserInfo> {
    return this._getUser(docSession);
  }

  public async getCachedUser(docSession: OptDocSession): Promise<UserInfo> {
    const access = await this._getAccess(docSession);
    return access.getUser();
  }

  /**
   * Check whether user has any access to table.
   */
  public async hasTableAccess(docSession: OptDocSession, tableId: string) {
    const pset = await this.getTableAccess(docSession, tableId);
    return this.getReadPermission(pset) !== 'deny';
  }

  /**
   * Get content of a given cell, if user has read access.
   * Throws if not.
   */
  public async getCellValue(docSession: OptDocSession, cell: SingleCell): Promise<CellValue> {
    function fail(): never {
      throw new ErrorWithCode('ACL_DENY', 'Cannot access cell');
    }
    const pset = await this.getTableAccess(docSession, cell.tableId);
    const tableAccess = this.getReadPermission(pset);
    if (tableAccess === 'deny') { fail(); }
    const rows = await this._fetchQueryFromDB({
      tableId: cell.tableId,
      filters: { id: [cell.rowId] }
    });
    if (!rows || rows[2].length === 0) { fail(); }
    const rec = new RecordView(rows, 0);
    const input: AclMatchInput = {user: await this._getUser(docSession), rec, newRec: rec};
    const rowPermInfo = new PermissionInfo(this._ruler.ruleCollection, input);
    const rowAccess = rowPermInfo.getTableAccess(cell.tableId).perms.read;
    if (rowAccess === 'deny') { fail(); }
    if (rowAccess !== 'allow') {
      const colAccess = rowPermInfo.getColumnAccess(cell.tableId, cell.colId).perms.read;
      if (colAccess === 'deny') { fail(); }
    }
    const colValues = rows[3];
    if (!(cell.colId in colValues)) { fail(); }
    return rec.get(cell.colId);
  }

  /**
   * Checks whether the specified cell is accessible by the user, and contains
   * the specified attachment. Throws with ACL_DENY code if not.
   */
  public async assertAttachmentAccess(docSession: OptDocSession, cell: SingleCell, attId: number): Promise<void> {
    const value = await this.getCellValue(docSession, cell);

    // Need to check column is actually an attachment column.
    if (this._docStorage.getColumnType(cell.tableId, cell.colId) !== 'Attachments') {
      throw new ErrorWithCode('ACL_DENY', 'not an attachment column');
    }

    // Check that material in cell includes the attachment.
    if (!gristTypes.isList(value)) {
      throw new ErrorWithCode('ACL_DENY', 'not a list');
    }
    if (value.indexOf(attId) <= 0) {
      throw new ErrorWithCode('ACL_DENY', 'attachment not present in cell');
    }
  }

  /**
   * Called after UserAction[]s have been applied in the sandbox, and DocAction[]s have been
   * computed, but before we have committed those DocAction[]s to the database.  If this
   * throws an exception, the sandbox changes will be reverted.
   */
  public async canApplyBundle() {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const {docActions, docSession, isDirect} = this._activeBundle;
    if (this._activeBundle.hasDeliberateRuleChange && !await this.isOwner(docSession)) {
      throw new ErrorWithCode('ACL_DENY', 'Only owners can modify access rules');
    }
    // Normally, viewer requests would never reach this point, but they can happen
    // using the "view as" functionality where user is an owner wanting to preview the
    // access level of another.  And again, the default access rules would normally
    // forbid edit access to a viewer - but that can be overridden.
    // An alternative to this check would be to sandwich user-defined access rules
    // between some defaults.  Currently the defaults have lower priority than
    // user-defined access rules.
    if (!canEdit(await this.getNominalAccess(docSession))) {
      throw new ErrorWithCode('ACL_DENY', 'Only owners or editors can modify documents');
    }
    if (this._ruler.haveRules()) {
      await Promise.all(
        docActions.map((action, actionIdx) => {
          if (isDirect[actionIdx]) {
            return this._checkIncomingDocAction({docSession, action, actionIdx});
          }
        }));
    }

    if (this._recoveryMode) {
      // Don't do any further checking in recovery mode.
      return;
    }

    // If the actions change any rules, verify that we'll be able to handle the changed rules. If
    // they are to cause an error, reject the action to avoid forcing user into recovery mode.
    // WATCH OUT - this will trigger for "passive" changes caused by tableId/colId renames.
    if (docActions.some(docAction => isAclTable(getTableId(docAction)))) {
      // Create a tmpDocData with just the tables we care about, then update docActions to it.
      const tmpDocData: DocData = new DocData(
        (tableId) => { throw new Error("Unexpected DocData fetch"); }, {
          _grist_Tables: this._docData.getMetaTable('_grist_Tables').getTableDataAction(),
          _grist_Tables_column: this._docData.getMetaTable('_grist_Tables_column').getTableDataAction(),
          _grist_ACLResources: this._docData.getMetaTable('_grist_ACLResources').getTableDataAction(),
          _grist_ACLRules: this._docData.getMetaTable('_grist_ACLRules').getTableDataAction(),
        });
      for (const da of docActions) {
        tmpDocData.receiveAction(da);
      }

      // Use the post-actions data to process the rules collection, and throw error if that fails.
      const ruleCollection = new ACLRuleCollection();
      await ruleCollection.update(tmpDocData, {log, compile: compileAclFormula});
      if (ruleCollection.ruleError) {
        throw new ApiError(ruleCollection.ruleError.message, 400);
      }
      try {
        ruleCollection.checkDocEntities(tmpDocData);
      } catch (err) {
        throw new ApiError(err.message, 400);
      }
    }
  }

  /**
   * This should be called after each action bundle has been applied to the database,
   * but before the actions are broadcast to clients.  It will set us up to be able
   * to efficiently filter those broadcasts.
   *
   * We expect actions bundles for a document to be applied+broadcast serially (the
   * broadcasts can be parallelized, but should complete before moving on to further
   * document mutation).
   */
  public async appliedBundle() {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const {docActions} = this._activeBundle;
    this._activeBundle.applied = true;
    if (!this._ruler.haveRules()) { return; }
    // Check if a table that affects user attributes has changed.  If so, put current
    // attributes aside for later comparison, and clear cache.
    const attrs = new Set([...this._ruler.ruleCollection.getUserAttributeRules().values()].map(r => r.tableId));
    const attrChange = docActions.some(docAction => attrs.has(getTableId(docAction)));
    if (attrChange) {
      this._prevUserAttributesMap = this._userAttributesMap;
      this._userAttributesMap = new WeakMap();
    }
    // If there's a schema change, zap permission cache.
    const schemaChange = docActions.some(docAction => isSchemaAction(docAction));
    if (attrChange || schemaChange) {
      this._ruler.clearCache();
    }
  }

  /**
   * This should be called once an action bundle has been broadcast to
   * all clients (or the bundle has been denied).  It will clean up
   * any temporary state cached for filtering those broadcasts.
   */
  public async finishedBundle() {
    if (!this._activeBundle) { return; }
    if (this._activeBundle.applied) {
      const {docActions} = this._activeBundle;
      await this._updateRules(docActions);
    }
    this._steps = null;
    this._metaSteps = null;
    this._prevUserAttributesMap = undefined;
    this._activeBundle = null;
  }

  /**
   * Filter DocActions to be sent to a client.
   */
  public async filterOutgoingDocActions(docSession: OptDocSession, docActions: DocAction[]): Promise<DocAction[]> {
    // If the user requested a rule change, trigger a reload.
    if (this._activeBundle?.hasDeliberateRuleChange) {
      // TODO: could avoid reloading in many cases, especially for an owner who has full
      // document access.
      throw new ErrorWithCode('NEED_RELOAD', 'document needs reload, access rules changed');
    }

    // Optimize case where there are no rules to enforce.
    if (!this._ruler.haveRules()) { return docActions; }

    // If user attributes have changed, trigger a reload.
    await this._checkUserAttributes(docSession);

    const actions = await Promise.all(
      docActions.map((action, actionIdx) => this._filterOutgoingDocAction({docSession, action, actionIdx})));
    return ([] as DocAction[]).concat(...actions);
  }

  /**
   * Filter an ActionGroup to be sent to a client.
   */
  public async filterActionGroup(
    docSession: OptDocSession,
    actionGroup: ActionGroup,
    options: {role?: Role | null} = {}
  ): Promise<ActionGroup> {
    if (await this.allowActionGroup(docSession, actionGroup, options)) { return actionGroup; }
    // For now, if there's any nuance at all, suppress the summary and description.
    const result: ActionGroup = { ...actionGroup };
    result.actionSummary = createEmptyActionSummary();
    result.desc = '';
    return result;
  }

  /**
   * Check whether an ActionGroup can be sent to the client.  TODO: in future, we'll want
   * to filter acceptable parts of ActionGroup, rather than denying entirely.
   */
  public async allowActionGroup(
    docSession: OptDocSession,
    _actionGroup: ActionGroup,
    options: {role?: Role | null} = {}
  ): Promise<boolean> {
    return this.canReadEverything(docSession, options);
  }

  /**
   * Filter DocUsageSummary to be sent to a client.
   */
  public async filterDocUsageSummary(
    docSession: OptDocSession,
    docUsage: DocUsageSummary,
    options: {role?: Role | null} = {}
  ): Promise<FilteredDocUsageSummary> {
    const result: FilteredDocUsageSummary = { ...docUsage };
    const role = options.role ?? await this.getNominalAccess(docSession);
    const hasEditRole = canEdit(role);
    if (!hasEditRole) { result.dataLimitStatus = null; }
    const hasFullReadAccess = await this.canReadEverything(docSession);
    if (!hasEditRole || !hasFullReadAccess) {
      result.rowCount = 'hidden';
      result.dataSizeBytes = 'hidden';
      result.attachmentsSizeBytes = 'hidden';
    }
    return result;
  }

  /**
   * Check if user may be able to apply a list of actions.  Throws if
   * user cannot apply an action.  Returns true if a user can perhaps apply an
   * action, or false if we know we need to defer making that determination
   * until the data engine translates the user actions to doc actions.
   */
  public async assertCanMaybeApplyUserActions(docSession: OptDocSession, actions: UserAction[]): Promise<boolean> {
    if (this._hasExceptionalFullAccess(docSession)) { return true; }

    let canMaybeApply = true;
    for (const action of actions) {
      if (!await this.assertCanMaybeApplyUserAction(docSession, action)) {
        canMaybeApply = false;
        break;
      }
    }

    await this._checkPossiblePythonFormulaModification(docSession, actions);
    await this._checkAddOrUpdateAccess(docSession, actions);

    return canMaybeApply;
  }

  /**
   * Called when it is permissible to partially fulfill the requested actions.
   * Will remove forbidden actions in a very limited set of recognized circumstances.
   * In fact, currently in only one circumstance:
   *
   *   - If there is a single requested action, and it is an ApplyUndoActions.
   *     The goal being to let a user undo their action to the extent that it
   *     is possible to do so.
   *
   * In this case, the list of actions nested in ApplyUndoActions will be extracted,
   * treated as DocActions, and filtered to remove any component parts (at action,
   * column, row, or individual cell level) that would be forbidden.
   *
   * Beyond pure data changes, there are no heroics - any schema change will
   * result in prefiltering being skipped.
   *
   * Any filtering done here is NOT a security measure, and the output should
   * not be granted any level of automatic trust.
   */
  public async prefilterUserActions(docSession: OptDocSession, actions: UserAction[]): Promise<UserAction[]> {
    // Currently we only attempt prefiltering for an ApplyUndoActions.
    if (actions.length !== 1) { return actions; }
    const userAction = actions[0];
    if (userAction[0] !== 'ApplyUndoActions') { return actions; }

    // Ok, this is an undo.  Unpack the requested undo actions.  For a bona
    // fide ApplyUndoActions, these would be doc actions generated by the
    // data engine and stored in action history.  But there is no actual
    // restriction in how ApplyUndoActions could be generated.  Security
    // is enforced separately, so we don't need to be paranoid here.
    const docActions = userAction[1] as DocAction[];

    // Bail out if there is any hint of a schema change.
    // TODO: may want to also bail if an action we'd need to filter would
    // affect a row id used later in the bundle.  Perhaps prefiltering
    // should be restricted to bundles of updates only for that reason.
    for (const action of docActions) {
      if (!isDataAction(action) || getTableId(action).startsWith('_grist')) {
        return actions;
      }
    }

    // Run through a simulation of access control on these actions,
    // retaining only permitted material.
    const proposedActions: UserAction[] = [];
    try {
      // Establish our doc actions as the current context for access control.
      // We don't have undo information for them, but don't need to because
      // they have not been applied to the db.  Treat all actions as "direct"
      // since we could not trust claims of indirectness currently in
      // any case (though we could rearrange to limit how undo actions are
      // requested).
      this.getGranularAccessForBundle(docSession, docActions, [], docActions,
                                      docActions.map(() => true));
      for (const [actionIdx, action] of docActions.entries()) {
        // A single action might contain forbidden material at cell, row, column,
        // or table level.  Retaining permitted material may require refactoring the
        // single action into a series of actions.
        try {
          await this._checkIncomingDocAction({docSession, action, actionIdx});
          // Nothing forbidden!  Keep this action unchanged.
          proposedActions.push(action);
        } catch (e) {
          if (String(e.code) !== 'ACL_DENY') { throw e; }
          const acts = await this._prefilterDocAction({docSession, action, actionIdx});
          proposedActions.push(...acts);
          // Presumably we've changed the action.  Zap our cache of intermediate
          // states, since it is stale now.  TODO: reorganize cache to so can avoid wasting
          // time repeating work unnecessarily.  The cache was designed with all-or-nothing
          // operations in mind, and is poorly suited to prefiltering.
          // Note: the meaning of newRec is slippery in prefiltering, since it depends on
          // state at the end of the bundle, but that state is unstable now.
          // TODO look into prefiltering in cases using newRec in a many-action bundle.
          this._steps = null;
          this._metaSteps = null;
        }
      }
    } finally {
      await this.finishedBundle();
    }
    return [['ApplyUndoActions', proposedActions]];
  }

  /**
   * Check if user may be able to apply a given action.  Throws if
   * user cannot apply the action.  Returns true if a user can apply an
   * action, or false if we need to defer making that determination
   * until the data engine translates the user actions to doc actions.
   */
  public async assertCanMaybeApplyUserAction(docSession: OptDocSession, a: UserAction|DocAction): Promise<boolean> {
    const name = a[0] as string;
    if (this._hasExceptionalFullAccess(docSession)) { return true; }
    if (OK_ACTIONS.has(name)) { return true; }
    if (SPECIAL_ACTIONS.has(name)) {
      if (await this.hasNuancedAccess(docSession)) {
        throw new ErrorWithCode('ACL_DENY', `Blocked by access rules: '${name}' actions need uncomplicated access`);
      }
      return true;
    }
    if (SURPRISING_ACTIONS.has(name)) {
      if (!await this.hasFullAccess(docSession)) {
        throw new ErrorWithCode('ACL_DENY', `Blocked by access rules: '${name}' actions need full access`);
      }
      return true;
    }
    if (name === 'ApplyUndoActions') {
      return this.assertCanMaybeApplyUserActions(docSession, a[1] as UserAction[]);
    } else if (name === 'ApplyDocActions') {
      return this.assertCanMaybeApplyUserActions(docSession, a[1] as UserAction[]);
    } else if (name === 'AddOrUpdateRecord') {
      // This case is a bit tricky.
      // Access is checked separately in _checkAddOrUpdateAccess.
      return true;
    } else if (isDataAction(a)) {
      const tableId = getTableId(a);
      if (tableId.startsWith('_grist_')) {
        return false;  // have to look closely
      }
      const tableAccess = await this.getTableAccess(docSession, tableId);
      const accessCheck = await this._getAccessForActionType(docSession, a, 'fatal');
      accessCheck.get(tableAccess);  // will throw if access denied.
      return true;
    } else {
      return false;  // have to look closely
    }
  }

  /**
   * For changes that could include Python formulas, check for schema access early.
   */
  public needEarlySchemaPermission(a: UserAction|DocAction): boolean {
    const name = a[0] as string;
    if (name === 'ModifyColumn' || name === 'SetDisplayFormula') {
      return true;
    } else if (isDataAction(a)) {
      const tableId = getTableId(a);
      if (tableId === '_grist_Tables_column' || tableId === '_grist_Validations') {
        return true;
      }
    }
    return false;
  }

  /**
   * Check whether access is simple, or there are granular nuances that need to be
   * worked through.  Currently if there are no owner-only tables, then everyone's
   * access is simple and without nuance.
   */
  public async hasNuancedAccess(docSession: OptDocSession): Promise<boolean> {
    if (!this._ruler.haveRules()) { return false; }
    return !await this.hasFullAccess(docSession);
  }

  /**
   * Check if user is explicitly permitted to download/copy document.
   * They may be allowed to download in any case, see canCopyEverything.
   */
  public async hasFullCopiesPermission(docSession: OptDocSession): Promise<boolean> {
    const permInfo = await this._getAccess(docSession);
    return permInfo.getColumnAccess(SPECIAL_RULES_TABLE_ID, 'FullCopies').perms.read === 'allow';
  }

  /**
   * Check if user may view Access Rules.
   */
  public async hasAccessRulesPermission(docSession: OptDocSession): Promise<boolean> {
    const permInfo = await this._getAccess(docSession);
    return permInfo.getColumnAccess(SPECIAL_RULES_TABLE_ID, 'AccessRules').perms.read === 'allow';
  }

  /**
   * Check whether user can read everything in document.  Checks both home-level and doc-level
   * permissions.
   */
  public async canReadEverything(
    docSession: OptDocSession,
    options: {role?: Role | null} = {}
  ): Promise<boolean> {
    const access = options.role ?? await this.getNominalAccess(docSession);
    if (!canView(access)) { return false; }
    const permInfo = await this._getAccess(docSession);
    return this.getReadPermission(permInfo.getFullAccess()) === 'allow';
  }

  /**
   * An odd little right for findColFromValues and autocomplete.  Allow if user can read
   * all data, or is an owner.  Might be worth making a special permission.
   */
  public async canScanData(docSession: OptDocSession): Promise<boolean> {
    return await this.isOwner(docSession) || await this.canReadEverything(docSession);
  }

  /**
   * Check whether user can copy everything in document.  Owners can always copy
   * everything, even if there are rules that specify they cannot.
   *
   * There's a small wrinkle about access rules.  The content
   * of _grist_ACLRules and Resources are only send to clients that are owners,
   * but could be copied by others by other means (e.g. download) as long as all
   * tables or columns are readable. This seems ok (no private info involved),
   * just a bit inconsistent.
   */
  public async canCopyEverything(docSession: OptDocSession): Promise<boolean> {
    return await this.hasFullCopiesPermission(docSession) ||
      await this.canReadEverything(docSession);
  }

  /**
   * Check whether user has full access to the document.  Currently that is interpreted
   * as equivalent owner-level access to the document.
   * TODO: uses of this method should be checked to see if they can be fleshed out
   * now we have more of the ACL implementation done.
   */
  public hasFullAccess(docSession: OptDocSession): Promise<boolean> {
    return this.isOwner(docSession);
  }

  /**
   * Check whether user has owner-level access to the document.
   */
  public async isOwner(docSession: OptDocSession): Promise<boolean> {
    const access = await this.getNominalAccess(docSession);
    return access === 'owners';
  }

  /**
   *
   * If the user does not have access to the full document, we need to filter out
   * parts of the document metadata.  For simplicity, we overwrite rather than
   * filter for now, so that the overall structure remains consistent.  We overwrite:
   *
   *   - names, textual ids, formulas, and other textual options
   *   - foreign keys linking columns/views/sections back to a forbidden table
   *
   * On the client, a page with a blank name will be marked gracefully as unavailable.
   *
   * Some information leaks, for example the existence of private tables and how
   * many columns they had, and something of the relationships between them. Long term,
   * it could be better to zap rows entirely, and do the work of cleaning up any cross
   * references to them.
   *
   */
  public async filterMetaTables(docSession: OptDocSession,
                                tables: {[key: string]: TableDataAction}): Promise<{[key: string]: TableDataAction}> {
    // If user has right to read everything, return immediately.
    if (await this.canReadEverything(docSession)) { return tables; }
    // If we are going to modify metadata, make a copy.
    tables = cloneDeep(tables);

    const permInfo = await this._getAccess(docSession);
    const censor = new CensorshipInfo(permInfo, this._ruler.ruleCollection, tables,
                                      await this.hasAccessRulesPermission(docSession));

    for (const tableId of STRUCTURAL_TABLES) {
      censor.apply(tables[tableId]);
    }
    return tables;
  }

  /**
   * Distill the clauses for the given session and table, to figure out the
   * access level and any row-level access functions needed.
   */
  public async getTableAccess(docSession: OptDocSession, tableId: string): Promise<TablePermissionSetWithContext> {
    if (this._hasExceptionalFullAccess(docSession)) {
      return {
        perms: {read: 'allow', create: 'allow', delete: 'allow', update: 'allow', schemaEdit: 'allow'},
        ruleType: 'table',
        getMemos() { throw new Error('never needed'); }
      };
    }
    return (await this._getAccess(docSession)).getTableAccess(tableId);
  }

  /**
   * Modify table data in place, removing any rows or columns to which access
   * is not granted.
   */
  public async filterData(docSession: OptDocSession, data: TableDataAction) {
    const permInfo = await this._getAccess(docSession);
    const cursor: ActionCursor = {docSession, action: data, actionIdx: null};
    const tableId = getTableId(data);
    if (this.getReadPermission(permInfo.getTableAccess(tableId)) === 'mixed') {
      const readAccessCheck = this._readAccessCheck(docSession);
      await this._filterRowsAndCells(cursor, data, data, readAccessCheck, {allowRowRemoval: true});
    }

    // Filter columns, omitting any to which the user has no access, regardless of rows.
    this._filterColumns(
      data[3],
      (colId) => this.getReadPermission(permInfo.getColumnAccess(tableId, colId)) !== 'deny');
  }

  public async getUserOverride(docSession: OptDocSession): Promise<UserOverride|undefined> {
    await this._getUser(docSession);
    return this._getUserAttributes(docSession).override;
  }

  public getReadPermission(ps: PermissionSetWithContext) {
    return ps.perms.read;
  }

  public assertCanRead(ps: PermissionSetWithContext) {
    accessChecks.fatal.read.get(ps);
  }

  /**
   * Broadcast document changes to all clients, with appropriate filtering.
   */
  public async sendDocUpdateForBundle(actionGroup: ActionGroup, docUsage: DocUsageSummary) {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const { docActions, docSession } = this._activeBundle;
    const client = docSession && docSession.client || null;
    const message: DocUpdateMessage = { actionGroup, docActions, docUsage };
    await this._docClients.broadcastDocMessage(client, 'docUserAction',
                                               message,
                                               (_docSession) => this._filterDocUpdate(_docSession, message));
  }

  // Remove cached access information for a given session.
  public flushAccess(docSession: OptDocSession) {
    this._ruler.flushAccess(docSession);
    this._userAttributesMap.delete(docSession);
    this._prevUserAttributesMap?.delete(docSession);
  }

  // Get a set of example users for playing with access control.
  // We use the example.com domain, which is reserved for uses like this.
  public getExampleViewAsUsers(): UserAccessData[] {
    return [
      {id: 0, email: 'owner@example.com', name: 'Owner', access: 'owners'},
      {id: 0, email: 'editor1@example.com', name: 'Editor 1', access: 'editors'},
      {id: 0, email: 'editor2@example.com', name: 'Editor 2', access: 'editors'},
      {id: 0, email: 'viewer@example.com', name: 'Viewer', access: 'viewers'},
      {id: 0, email: 'unknown@example.com', name: 'Unknown User', access: null},
    ];
  }

  // Compile a list of users mentioned in user attribute tables keyed by email.
  // If there is a Name column or an Access column, in the table, we use them.
  public async collectViewAsUsersFromUserAttributeTables(): Promise<Array<Partial<UserAccessData>>> {
    const result: Array<Partial<UserAccessData>> = [];
    for (const clause of this._ruler.ruleCollection.getUserAttributeRules().values()) {
      if (clause.charId !== 'Email') { continue; }
      try {
        const users = await this._fetchQueryFromDB({
          tableId: clause.tableId,
          filters: {},
        });
        const user = new RecordView(users, undefined);
        const count = users[2].length;
        for (let i = 0; i < count; i++) {
          user.index = i;
          const email = user.get(clause.lookupColId);
          const name = user.get('Name') || String(email).split('@')[0];
          const access = user.has('Access') ? String(user.get('Access')) : 'editors';
          result.push({
            email: email ? String(email) : undefined,
            name: name ? String(name) : undefined,
            access: isValidRole(access) ? access : null,  // 'null' -> null a bit circuitously
          });
        }
      } catch (e) {
        log.warn(`User attribute ${clause.name} failed`, e);
      }
    }
    return result;
  }

  /**
   * Get the role the session user has for this document.  User may be overridden,
   * in which case the role of the override is returned.
   * The forkingAsOwner flag of docSession should not be respected for non-owners,
   * so that the pseudo-ownership it offers is restricted to granular access within a
   * document (as opposed to document-level operations).
   */
  public async getNominalAccess(docSession: OptDocSession): Promise<Role|null> {
    const linkParameters = docSession.authorizer?.getLinkParameters() || {};
    const baseAccess = getDocSessionAccess(docSession);
    if ((linkParameters.aclAsUserId || linkParameters.aclAsUser) && baseAccess === 'owners') {
      const info = await this._getUser(docSession);
      return info.Access;
    }
    return baseAccess;
  }

  // AddOrUpdateRecord requires broad read access to a table.
  // But tables can be renamed, and access can be granted and removed
  // within a bundle.
  //
  // For now, we forbid the combination of AddOrUpdateRecord and
  // with actions other than other AddOrUpdateRecords, or simple data
  // changes.
  //
  // Access rules and user attributes might change during the bundle.
  // We deny based on access rights at the beginning of the bundle,
  // as for _checkPossiblePythonFormulaModification. This is on the
  // theory that someone who can change access rights can do anything.
  //
  // There might be uses for applying AddOrUpdateRecord in a nuanced
  // way within the scope of what a user can read, but there's no easy
  // way to do that within the data engine as currently
  // formulated. Could perhaps be done for on-demand tables though.
  private async _checkAddOrUpdateAccess(docSession: OptDocSession, actions: UserAction[]) {
    if (!scanActionsRecursively(actions, (a) => a[0] === 'AddOrUpdateRecord')) {
      // Don't need to apply this particular check.
      return;
    }
    // Fail if being combined with anything fancy.
    if (scanActionsRecursively(actions, (a) => {
      const name = a[0];
      return !['ApplyUndoActions', 'ApplyDocActions', 'AddOrUpdateRecord'].includes(String(name)) &&
        !(isDataAction(a) && !getTableId(a).startsWith('_grist_'));
    })) {
      throw new Error('Can only combine AddOrUpdate with simple data changes');
    }
    // Check for read access, and that we're not touching metadata.
    await applyToActionsRecursively(actions, async (a) => {
      if (a[0] !== 'AddOrUpdateRecord') { return; }
      const tableId = validTableIdString(a[1]);
      if (tableId.startsWith('_grist_')) {
        throw new Error(`AddOrUpdate cannot yet be used on metadata tables`);
      }
      const tableAccess = await this.getTableAccess(docSession, tableId);
      accessChecks.fatal.read.throwIfNotFullyAllowed(tableAccess);
      accessChecks.fatal.update.throwIfDenied(tableAccess);
      accessChecks.fatal.create.throwIfDenied(tableAccess);
    });
  }

  private async _checkPossiblePythonFormulaModification(docSession: OptDocSession, actions: UserAction[]) {
    // If changes could include Python formulas, then user must have
    // +S before we even consider passing these to the data engine.
    // Since we don't track rule or schema changes at this stage, we
    // approximate with the user's access rights at beginning of
    // bundle.
    if (scanActionsRecursively(actions, (a) => this.needEarlySchemaPermission(a))) {
      await this._assertSchemaAccess(docSession);
    }
  }

  /**
   * Asserts that user has schema access.
   */
  private async _assertSchemaAccess(docSession: OptDocSession) {
    if (this._hasExceptionalFullAccess(docSession)) { return; }
    const permInfo = await this._getAccess(docSession);
    accessChecks.fatal.schemaEdit.throwIfDenied(permInfo.getFullAccess());
  }

  // The AccessCheck for the "read" permission is used enough to merit a shortcut.
  // We just need to be careful to retain unfettered access for exceptional sessions.
  private _readAccessCheck(docSession: OptDocSession): IAccessCheck {
    return this._hasExceptionalFullAccess(docSession) ? dummyAccessCheck : accessChecks.check.read;
  }

  // Return true for special system sessions or document-creation sessions, where
  // unfettered access is appropriate.
  private _hasExceptionalFullAccess(docSession: OptDocSession): Boolean {
    return docSession.mode === 'system' || docSession.mode === 'nascent';
  }

  /**
   * This filters a message being broadcast to all clients to be appropriate for one
   * particular client, if that client may need some material filtered out.
   */
  private async _filterDocUpdate(docSession: OptDocSession, message: DocUpdateMessage) {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const role = await this.getNominalAccess(docSession);
    const result = {
      ...message,
      docUsage: await this.filterDocUsageSummary(docSession, message.docUsage, {role}),
    };
    if (!this._ruler.haveRules() && !this._activeBundle.hasDeliberateRuleChange) {
      return result;
    }
    result.actionGroup = await this.filterActionGroup(docSession, message.actionGroup, {role});
    result.docActions = await this.filterOutgoingDocActions(docSession, message.docActions);
    if (result.docActions.length === 0) { return null; }
    return result;
  }

  private async _updateRules(docActions: DocAction[]) {
    // If there is a rule change, redo from scratch for now.
    // TODO: this is placeholder code. Should deal with connected clients.
    if (docActions.some(docAction => isAclTable(getTableId(docAction)))) {
      await this.update();
      return;
    }
    if (!this._ruler.haveRules()) { return; }
    // If there is a schema change, redo from scratch for now.
    if (docActions.some(docAction => isSchemaAction(docAction))) {
      await this.update();
    }
  }

  /**
   * Strip out any denied columns from an action.  Returns null if nothing is left.
   * accessCheck may throw if denials are fatal.
   */
  private _pruneColumns(a: DocAction, permInfo: IPermissionInfo, tableId: string,
                        accessCheck: IAccessCheck): DocAction|null {
    if (a[0] === 'RemoveRecord' || a[0] === 'BulkRemoveRecord') {
      return a;
    } else if (a[0] === 'AddRecord' || a[0] === 'BulkAddRecord' || a[0] === 'UpdateRecord' ||
               a[0] === 'BulkUpdateRecord' || a[0] === 'ReplaceTableData' || a[0] === 'TableData') {
      const na = cloneDeep(a);
      this._filterColumns(na[3], (colId) => accessCheck.get(permInfo.getColumnAccess(tableId, colId)) !== 'deny');
      if (Object.keys(na[3]).length === 0) { return null; }
      return na;
    } else if (a[0] === 'AddColumn' || a[0] === 'RemoveColumn' || a[0] === 'RenameColumn' ||
               a[0] === 'ModifyColumn') {
      const colId: string = a[2];
      if (accessCheck.get(permInfo.getColumnAccess(tableId, colId)) === 'deny') { return null; }
    } else {
      // Remaining cases of AddTable, RemoveTable, RenameTable should have
      // been handled at the table level.
    }
    return a;
  }

  /**
   * Strip out any denied rows from an action.  The action may be rewritten if rows
   * become allowed or denied during the action.  An action to add newly-allowed
   * rows may be included, or an action to remove newly-forbidden rows.  The result
   * is a list rather than a single action.  It may be the empty list.
   */
  private async _pruneRows(cursor: ActionCursor): Promise<DocAction[]> {
    const {action} = cursor;
    // This only deals with Record-related actions.
    if (!isDataAction(action)) { return [action]; }

    // Get before/after state for this action.  Broadcasts to other users can make use of the
    // same state, so we share it (and only compute it if needed).
    const {rowsBefore, rowsAfter} = await this._getRowsBeforeAndAfter(cursor);

    // Figure out which rows were forbidden to this session before this action vs
    // after this action.  We need to know both so that we can infer the state of the
    // client and send the correct change.
    const orderedIds = getRowIdsFromDocAction(action);
    const ids = new Set(orderedIds);
    const forbiddenBefores = new Set(await this._getForbiddenRows(cursor, rowsBefore, ids));
    const forbiddenAfters = new Set(await this._getForbiddenRows(cursor, rowsAfter, ids));

    /**
     * For rows forbidden before and after: just remove them.
     * For rows allowed before and after: just leave them unchanged.
     * For rows that were allowed before and are now forbidden:
     *   - strip them from the current action.
     *   - add a BulkRemoveRecord for them.
     * For rows that were forbidden before and are now allowed:
     *   - remove them from the current action.
     *   - add a BulkAddRecord for them.
     */

    const removals = new Set<number>();      // rows to remove from current action.
    const forceAdds = new Set<number>();     // rows to add, that were previously stripped.
    const forceRemoves = new Set<number>();  // rows to remove, that have become forbidden.
    for (const id of ids) {
      const forbiddenBefore = forbiddenBefores.has(id);
      const forbiddenAfter = forbiddenAfters.has(id);
      if (!forbiddenBefore && !forbiddenAfter) { continue; }
      if (forbiddenBefore && forbiddenAfter) {
        removals.add(id);
        continue;
      }
      // If we reach here, then access right to the row changed and we have fancy footwork to do.
      if (forbiddenBefore) {
        // The row was forbidden and now is allowed.  That's trivial if the row was just added.
        if (action[0] === 'AddRecord' || action[0] === 'BulkAddRecord' ||
            action[0] === 'ReplaceTableData' || action[0] === 'TableData') {
          continue;
        }
        // Otherwise, strip the row from the current action.
        removals.add(id);
        if (action[0] === 'UpdateRecord' || action[0] === 'BulkUpdateRecord') {
          // For updates, we need to send the entire row as an add, since the client
          // doesn't know anything about it yet.
          forceAdds.add(id);
        } else {
          // Remaining cases are [Bulk]RemoveRecord.
        }
      } else {
        // The row was allowed and now is forbidden.
        // If the action is a removal, that is just right.
        if (action[0] === 'RemoveRecord' || action[0] === 'BulkRemoveRecord') { continue; }
        // Otherwise, strip the row from the current action.
        removals.add(id);
        if (action[0] === 'UpdateRecord' || action[0] === 'BulkUpdateRecord') {
          // For updates, we need to remove the entire row.
          forceRemoves.add(id);
        } else {
          // Remaining cases are add-like actions.
        }
      }
    }
    // Execute our cunning plans for DocAction revisions.
    const revisedDocActions = [
      this._makeAdditions(rowsAfter, forceAdds),
      this._removeRows(action, removals),
      this._makeRemovals(rowsAfter, forceRemoves),
    ].filter(isNonNullish);

    // Check whether there are column rules for this table, and if so whether they are row
    // dependent.  If so, we may need to update visibility of cells not mentioned in the
    // original DocAction.
    // No censorship is done here, all we do at this point is pull in any extra cells that need
    // to be updated for the current client.  Censorship for these cells, and any cells already
    // present in the DocAction, is done by _filterRowsAndCells.
    const ruler = await this._getRuler(cursor);
    const tableId = getTableId(action);
    const ruleSets = ruler.ruleCollection.getAllColumnRuleSets(tableId);
    const colIds = new Set(([] as string[]).concat(
      ...ruleSets.map(ruleSet => ruleSet.colIds === '*' ? [] : ruleSet.colIds)
    ));
    const access = await ruler.getAccess(cursor.docSession);
    // Check columns in a consistent order, for determinism (easier testing).
    // TODO: could pool some work between columns by doing them together rather than one by one.
    for (const colId of [...colIds].sort()) {
      // If the column is already in the DocAction, we can skip checking if we need to add it.
      if (!action[3] || (colId in action[3])) { continue; }
      // If the column is not row dependent, we have nothing to do.
      if (access.getColumnAccess(tableId, colId).perms.read !== 'mixed') { continue; }
      // Check column accessibility before and after.
      const _forbiddenBefores = new Set(await this._getForbiddenRows(cursor, rowsBefore, ids, colId));
      const _forbiddenAfters = new Set(await this._getForbiddenRows(cursor, rowsAfter, ids, colId));
      // For any column that is in a visible row and for which accessibility has changed,
      // pull it into the doc actions.  We don't censor cells yet, that happens later
      // (if that's what needs doing).
      const changedIds = orderedIds.filter(id => !forceRemoves.has(id) && !removals.has(id) &&
                                        (_forbiddenBefores.has(id) !== _forbiddenAfters.has(id)));
      if (changedIds.length > 0) {
        revisedDocActions.push(this._makeColumnUpdate(rowsAfter, colId, new Set(changedIds)));
      }
    }

    // Return the results, also applying any cell-level access control.
    const readAccessCheck = this._readAccessCheck(cursor.docSession);
    const filteredDocActions: DocAction[] = [];
    for (const a of revisedDocActions) {
      const {filteredAction} =
        await this._filterRowsAndCells({...cursor, action: a}, rowsAfter, rowsAfter, readAccessCheck,
                                       {allowRowRemoval: false, copyOnModify: true});
      if (filteredAction) { filteredDocActions.push(filteredAction); }
    }
    return filteredDocActions;
  }

  /**
   * Like _pruneRows, but fails immediately if access to any row is forbidden.
   * The accessCheck supplied should throw an error on denial.
   */
  private async _checkRows(cursor: ActionCursor, accessCheck: IAccessCheck): Promise<void> {
    const {action} = cursor;
    // This check applies to data changes only.
    if (!isDataAction(action)) { return; }
    const {rowsBefore, rowsAfter} = await this._getRowsForRecAndNewRec(cursor);
    // If any change is needed, this call will fail immediately because we are using
    // access checks that throw.
    await this._filterRowsAndCells(cursor, rowsBefore, rowsAfter, accessCheck,
                                   {allowRowRemoval: false});
  }

  private async _getRowsBeforeAndAfter(cursor: ActionCursor) {
    const {rowsBefore, rowsAfter} = await this._getStep(cursor);
    if (!rowsBefore || !rowsAfter) { throw new Error('Logic error: no rows available'); }
    return {rowsBefore, rowsAfter};
  }

  private async _getRowsForRecAndNewRec(cursor: ActionCursor) {
    const steps = await this._getSteps();
    if (cursor.actionIdx === null) { throw new Error('No step available'); }
    const {rowsBefore, rowsLast} = steps[cursor.actionIdx];
    if (!rowsBefore) { throw new Error('Logic error: no previous rows available'); }
    if (rowsLast) {
      return {rowsBefore, rowsAfter: rowsLast};
    }
    // When determining whether to apply an action, we choose to make newRec refer to the
    // state at the end of the entire bundle.  So we look for the last pair of row snapshots
    // for the same table.
    // TODO: there's a problem that this could alias rows if row ids were reused within the
    // same bundle. It is kind of a slippery idea. Likewise, column renames are slippery.
    // We could solve a lot of slipperiness by having newRec not transition across schema
    // changes, but we don't really have the option because formula updates happen late.
    let tableId = getTableId(rowsBefore);
    let last = cursor.actionIdx;
    for (let i = last + 1; i < steps.length; i++) {
      const act = steps[i].action;
      if (getTableId(act) !== tableId) { continue; }
      if (act[0] === 'RenameTable') {
        tableId = act[2];
        continue;
      }
      last = i;
    }
    const rowsAfter = steps[cursor.actionIdx].rowsLast = steps[last].rowsAfter;
    if (!rowsAfter) { throw new Error('Logic error: no next rows available'); }
    return {rowsBefore, rowsAfter};
  }

  /**
   * Scrub any rows and cells to which access is not granted from an
   * action. Returns filteredAction, which is the provided action, a
   * modified copy of the provided action, or null. It is null if the
   * action was entirely eliminated (and was not a bulk action). It is
   * a modified copy if any scrubbing was needed and copyOnModify is
   * set, otherwise the original is modified in place.
   *
   * Also returns censoredRows, a set of indexes of rows that have a
   * censored value in them.
   *
   * If allowRowRemoval is false, then rows will not be removed, and if the user
   * does not have access to a row and the action itself is not a remove action, then
   * an error will be thrown.  This flag setting is used when filtering outgoing
   * actions, where actions need rewriting elsewhere to reflect access changes to
   * rows for each individual client.
   */
  private async _filterRowsAndCells(cursor: ActionCursor, rowsBefore: TableDataAction, rowsAfter: TableDataAction,
                                    accessCheck: IAccessCheck,
                                    options: {
                                      allowRowRemoval?: boolean,
                                      copyOnModify?: boolean,
                                    }): Promise<{
                                      filteredAction: DocAction | null,
                                      censoredRows: Set<number>
                                    }> {
    const censoredRows = new Set<number>();
    const ruler = await this._getRuler(cursor);
    const {docSession, action} = cursor;
    if (action && isSchemaAction(action)) {
      return {filteredAction: action, censoredRows};
    }
    let filteredAction: DocAction | null = action;

    // For user convenience, for creations and deletions we equate rec and newRec.
    // This makes writing rules that control multiple permissions easier to write in
    // practice.
    let rowsRec = rowsBefore;
    let rowsNewRec = rowsAfter;
    if (isAddRecordAction(action)) {
      rowsRec = rowsAfter;
    } else if (isRemoveRecordAction(action)) {
      rowsNewRec = rowsBefore;
    }

    const rec = new RecordView(rowsRec, undefined);
    const newRec = new RecordView(rowsNewRec, undefined);
    const input: AclMatchInput = {user: await this._getUser(docSession), rec, newRec};

    const [, tableId, , colValues] = action;
    let filteredColValues: ColValues | BulkColValues | undefined | null = null;
    const rowIds = getRowIdsFromDocAction(action);
    const toRemove: number[] = [];

    // Call this to make sure we are modifying a copy, not the original, if copyOnModify is set.
    const copyOnNeed = () => {
      if (filteredColValues === null) {
        filteredAction = options?.copyOnModify ? cloneDeep(action) : action;
        filteredColValues = filteredAction[3];
      }
      return filteredColValues;
    };
    let censorAt: (colId: string, idx: number) => void;
    if (colValues === undefined) {
      censorAt = () => 1;
    } else if (Array.isArray(action[2])) {
      censorAt = (colId, idx) => (copyOnNeed() as BulkColValues)[colId][idx] = [GristObjCode.Censored];
    } else {
      censorAt = (colId) => (copyOnNeed() as ColValues)[colId] = [GristObjCode.Censored];
    }

    // These map an index of a row in the action to its index in rowsBefore and in rowsAfter.
    let getRecIndex: (idx: number) => number|undefined = (idx) => idx;
    let getNewRecIndex: (idx: number) => number|undefined = (idx) => idx;
    if (action !== rowsRec) {
      const recIndexes = new Map(rowsRec[2].map((rowId, idx) => [rowId, idx]));
      getRecIndex = (idx) => recIndexes.get(rowIds[idx]);
    }
    if (action !== rowsNewRec) {
      const newRecIndexes = new Map(rowsNewRec[2].map((rowId, idx) => [rowId, idx]));
      getNewRecIndex = (idx) => newRecIndexes.get(rowIds[idx]);
    }

    for (let idx = 0; idx < rowIds.length; idx++) {
      rec.index = getRecIndex(idx);
      newRec.index = getNewRecIndex(idx);

      const rowPermInfo = new PermissionInfo(ruler.ruleCollection, input);
      // getTableAccess() evaluates all column rules for THIS record. So it's really rowAccess.
      const rowAccess = rowPermInfo.getTableAccess(tableId);
      const access = accessCheck.get(rowAccess);
      if (access === 'deny') {
        toRemove.push(idx);
      } else if (access !== 'allow' && colValues) {
        // Go over column rules.
        for (const colId of Object.keys(colValues)) {
          const colAccess = rowPermInfo.getColumnAccess(tableId, colId);
          if (accessCheck.get(colAccess) === 'deny') {
            censorAt(colId, idx);
            censoredRows.add(idx);
          }
        }
      }
    }

    if (toRemove.length > 0) {
      if (options.allowRowRemoval) {
        copyOnNeed();
        if (Array.isArray(filteredAction[2])) {
          this._removeRowsAt(toRemove, filteredAction[2], filteredAction[3]);
        } else {
          filteredAction = null;
        }
      } else {
        // Artificially introduced removals are ok, otherwise this is suspect.
        if (filteredAction[0] !== 'RemoveRecord' && filteredAction[0] !== 'BulkRemoveRecord') {
          throw new Error('Unexpected row removal');
        }
      }
    }
    return {filteredAction, censoredRows};
  }

  // Compute which of the row ids supplied are for rows forbidden for this session.
  // If colId is supplied, check instead whether that specific column is forbidden.
  private async _getForbiddenRows(cursor: ActionCursor, data: TableDataAction, ids: Set<number>,
                                  colId?: string): Promise<number[]> {
    const ruler = await this._getRuler(cursor);
    const rec = new RecordView(data, undefined);
    const input: AclMatchInput = {user: await this._getUser(cursor.docSession), rec};

    const [, tableId, rowIds] = data;
    const toRemove: number[] = [];
    for (let idx = 0; idx < rowIds.length; idx++) {
      rec.index = idx;
      if (!ids.has(rowIds[idx])) { continue; }

      const rowPermInfo = new PermissionInfo(ruler.ruleCollection, input);
      // getTableAccess() evaluates all column rules for THIS record. So it's really rowAccess.
      const rowAccess = rowPermInfo.getTableAccess(tableId);
      if (!colId) {
        if (this.getReadPermission(rowAccess) === 'deny') {
          toRemove.push(rowIds[idx]);
        }
      } else {
        const colAccess = rowPermInfo.getColumnAccess(tableId, colId);
        if (this.getReadPermission(colAccess) === 'deny') {
          toRemove.push(rowIds[idx]);
        }
      }
    }
    return toRemove;
  }

  /**
   * Removes the toRemove rows (indexes, not row ids) from the rowIds list and from
   * the colValues structure.
   *
   * toRemove must be sorted, lowest to highest.
   */
  private _removeRowsAt(toRemove: number[], rowIds: number[], colValues: BulkColValues|ColValues|undefined) {
    if (toRemove.length > 0) {
      pruneArray(rowIds, toRemove);
      if (colValues) {
        for (const values of Object.values(colValues)) {
          pruneArray(values, toRemove);
        }
      }
    }
  }

  /**
   * Remove columns from a ColumnValues parameter of certain DocActions, using a predicate for
   * which columns to keep.
   * Will retain manualSort columns regardless of wildcards.
   */
  private _filterColumns(data: BulkColValues|ColValues, shouldInclude: (colId: string) => boolean) {
    for (const colId of Object.keys(data)) {
      if (colId !== 'manualSort' && !shouldInclude(colId)) {
        delete data[colId];
      }
    }
  }

  /**
   * Get PermissionInfo for the user represented by the given docSession. The returned object
   * allows evaluating access level as far as possible without considering specific records.
   *
   * The result is cached in a WeakMap, and PermissionInfo does its own caching, so multiple calls
   * to this._getAccess(docSession).someMethod() will reuse already-evaluated results.
   */
  private async _getAccess(docSession: OptDocSession): Promise<PermissionInfo> {
    // TODO The intent of caching is to avoid duplicating rule evaluations while processing a
    // single request. Caching based on docSession is riskier since those persist across requests.
    return this._ruler.getAccess(docSession);
  }

  private _getUserAttributes(docSession: OptDocSession): UserAttributes {
    // TODO Same caching intent and caveat as for _getAccess
    return getSetMapValue(this._userAttributesMap as Map<OptDocSession, UserAttributes>, docSession,
                          () => new UserAttributes());
  }

  /**
   * Check whether user attributes have changed.  If so, prompt client
   * to reload the document, since we aren't sophisticated enough to
   * figure out the changes to send.
   */
  private async _checkUserAttributes(docSession: OptDocSession) {
    if (!this._prevUserAttributesMap) { return; }
    const userAttrBefore = this._prevUserAttributesMap.get(docSession);
    if (!userAttrBefore) { return; }
    await this._getAccess(docSession);  // Makes sure user attrs have actually been computed.
    const userAttrAfter = this._getUserAttributes(docSession);
    for (const [tableId, rec] of Object.entries(userAttrAfter.rows)) {
      const prev = userAttrBefore.rows[tableId];
      if (!prev || JSON.stringify(prev.toJSON()) !== JSON.stringify(rec.toJSON())) {
        throw new ErrorWithCode('NEED_RELOAD', 'document needs reload, user attributes changed');
      }
    }
  }

  /**
   * Construct the UserInfo needed for evaluating rules. This also enriches the user with values
   * created by user-attribute rules.
   */
  private async _getUser(docSession: OptDocSession): Promise<UserInfo> {
    const linkParameters = docSession.authorizer?.getLinkParameters() || {};
    let access: Role | null;
    let fullUser: FullUser | null;
    const attrs = this._getUserAttributes(docSession);
    access = getDocSessionAccess(docSession);

    if (docSession.forkingAsOwner) {
      // For granular access purposes, we become an owner.
      // It is a bit of a bluff, done on the understanding that this session will
      // never be used to edit the document, and that any edits will be done on a
      // fork.
      access = 'owners';
    }

    // If aclAsUserId/aclAsUser is set, then override user for acl purposes.
    if (linkParameters.aclAsUserId || linkParameters.aclAsUser) {
      if (access !== 'owners') { throw new ErrorWithCode('ACL_DENY', 'only an owner can override user'); }
      if (attrs.override) {
        // Used cached properties.
        access = attrs.override.access;
        fullUser = attrs.override.user;
      } else {
        attrs.override = await this._getViewAsUser(linkParameters);
        fullUser = attrs.override.user;
      }
    } else {
      fullUser = getDocSessionUser(docSession);
    }
    const user = new User();
    user.Access = access;
    const isAnonymous = fullUser?.id === this._homeDbManager?.getAnonymousUserId() ||
      fullUser?.id === null;
    user.UserID = (!isAnonymous && fullUser?.id) || null;
    user.Email = fullUser?.email || null;
    user.Name = fullUser?.name || null;
    // If viewed from a websocket, collect any link parameters included.
    // TODO: could also get this from rest api access, just via a different route.
    user.LinkKey = linkParameters;
    // Include origin info if accessed via the rest api.
    // TODO: could also get this for websocket access, just via a different route.
    user.Origin = docSession.req?.get('origin') || null;
    user.SessionID = isAnonymous ? `a${getDocSessionAltSessionId(docSession)}` : `u${user.UserID}`;
    user.IsLoggedIn = !isAnonymous;

    if (this._ruler.ruleCollection.ruleError && !this._recoveryMode) {
      // It is important to signal that the doc is in an unexpected state,
      // and prevent it opening.
      throw this._ruler.ruleCollection.ruleError;
    }

    for (const clause of this._ruler.ruleCollection.getUserAttributeRules().values()) {
      if (clause.name in user) {
        log.warn(`User attribute ${clause.name} ignored; conflicts with an existing one`);
        continue;
      }
      if (attrs.rows[clause.name]) {
        user[clause.name] = attrs.rows[clause.name];
        continue;
      }
      let rec = new EmptyRecordView();
      let rows: TableDataAction|undefined;
      try {
        // Use lodash's get() that supports paths, e.g. charId of 'a.b' would look up `user.a.b`.
        // TODO: add indexes to db.
        rows = await this._fetchQueryFromDB({
          tableId: clause.tableId,
          filters: { [clause.lookupColId]: [get(user, clause.charId)] }
        });
      } catch (e) {
        log.warn(`User attribute ${clause.name} failed`, e);
      }
      if (rows && rows[2].length > 0) { rec = new RecordView(rows, 0); }
      user[clause.name] = rec;
      attrs.rows[clause.name] = rec;
    }
    return user;
  }

  /**
   * Get the "View As" user specified in link parameters.
   * If aclAsUserId is set, we get the user with the specified id.
   * If aclAsUser is set, we get the user with the specified email,
   * from the database if possible, otherwise from user attribute
   * tables or examples.
   */
  private async _getViewAsUser(linkParameters: Record<string, string>): Promise<UserOverride> {
    // Look up user information in database.
    if (!this._homeDbManager) { throw new Error('database required'); }
    const dbUser = linkParameters.aclAsUserId ?
      (await this._homeDbManager.getUser(integerParam(linkParameters.aclAsUserId, 'aclAsUserId'))) :
      (await this._homeDbManager.getExistingUserByLogin(linkParameters.aclAsUser));
    if (!dbUser && linkParameters.aclAsUser) {
      // Look further for the user, in user attribute tables or examples.
      const otherUsers = (await this.collectViewAsUsersFromUserAttributeTables())
        .concat(this.getExampleViewAsUsers());
      const email = normalizeEmail(linkParameters.aclAsUser);
      const dummyUser = otherUsers.find(user => normalizeEmail(user?.email || '') === email);
      if (dummyUser) {
        return {
          access: dummyUser.access || null,
          user: {
            id: -1,
            email: dummyUser.email!,
            name: dummyUser.name || dummyUser.email!,
          }
        };
      }
    }
    const docAuth = dbUser && await this._homeDbManager.getDocAuthCached({
      urlId: this._docId,
      userId: dbUser.id
    });
    const access = docAuth?.access || null;
    const user = dbUser && this._homeDbManager.makeFullUser(dbUser) || null;
    return { access, user };
  }

  /**
   * Remove a set of rows from a DocAction.  If the DocAction ends up empty, null is returned.
   * If the DocAction needs modification, it is copied first - the original is never
   * changed.
   */
  private _removeRows(a: DocAction, rowIds: Set<number>): DocAction|null {
    // If there are no rows, there's nothing to do.
    if (isSchemaAction(a)) { return a; }
    if (a[0] === 'AddRecord' || a[0] === 'UpdateRecord' || a[0] === 'RemoveRecord') {
      return rowIds.has(a[2]) ? null : a;
    }
    const na = cloneDeep(a);
    const [, , oldIds, bulkColValues] = na;
    const mask = oldIds.map((id, idx) => rowIds.has(id) ? idx : false).filter(v => v !== false) as number[];
    this._removeRowsAt(mask, oldIds, bulkColValues);
    if (oldIds.length === 0) { return null; }
    return na;
  }

  /**
   * Make a BulkAddRecord for a set of rows.
   */
  private _makeAdditions(data: TableDataAction, rowIds: Set<number>): BulkAddRecord|null {
    if (rowIds.size === 0) { return null; }
    // TODO: optimize implementation, this does an unnecessary clone.
    const notAdded = data[2].filter(id => !rowIds.has(id));
    const partialData = this._removeRows(data, new Set(notAdded)) as TableDataAction|null;
    if (partialData === null) { return partialData; }
    return ['BulkAddRecord', partialData[1], partialData[2], partialData[3]];
  }

  /**
   * Make a BulkRemoveRecord for a set of rows.
   */
  private _makeRemovals(data: TableDataAction, rowIds: Set<number>): BulkRemoveRecord|null {
    if (rowIds.size === 0) { return null; }
    return ['BulkRemoveRecord', getTableId(data), [...rowIds]];
  }

  /**
   * Make a BulkUpdateRecord for a particular column across a set of rows.
   */
  private _makeColumnUpdate(data: TableDataAction, colId: string, rowIds: Set<number>): BulkUpdateRecord {
    const dataRowIds = data[2];
    const selectedRowIds = dataRowIds.filter(r => rowIds.has(r));
    const colData = data[3][colId].filter((value, idx) => rowIds.has(dataRowIds[idx]));
    return ['BulkUpdateRecord', getTableId(data), selectedRowIds, {[colId]: colData}];
  }

  private async _getSteps(): Promise<Array<ActionStep>> {
    if (!this._steps) {
      this._steps = this._getUncachedSteps().catch(e => {
        log.error('step computation failed:', e);
        throw e;
      });
    }
    return this._steps;
  }

  private async _getMetaSteps(): Promise<Array<MetaStep>> {
    if (!this._metaSteps) {
      this._metaSteps = this._getUncachedMetaSteps().catch(e => {
        log.error('meta step computation failed:', e);
        throw e;
      });
    }
    return this._metaSteps;
  }

  /**
   * Prepare to compute intermediate states of rows, as
   * this._steps.  The computation should happen only if
   * needed, which depends on the rules and actions.  The computation
   * uses the state of the database, and so depends on whether the
   * docActions have already been applied to the database or not, as
   * determined by the this._applied flag, which should never be
   * changed during any possible use of this._steps.
   */
  private async _getUncachedSteps(): Promise<Array<ActionStep>> {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const {docActions, undo, applied} = this._activeBundle;
    // For row access work, we'll need to know the state of affected rows before and
    // after the actions.
    // First figure out what rows in which tables are touched during the actions.
    const rows = new Map(getRelatedRows(applied ? [...undo].reverse() : docActions));
    // Populate a minimal in-memory version of the database with these rows.
    const docData = new DocData(
      (tableId) => this._fetchQueryFromDB({tableId, filters: {id: [...rows.get(tableId)!]}}),
      null,
    );
    // Load pre-existing rows touched by the bundle.
    await Promise.all([...rows.keys()].map(tableId => docData.syncTable(tableId)));
    if (applied) {
      // Apply the undo actions, since the docActions have already been applied to the db.
      for (const docAction of [...undo].reverse()) { docData.receiveAction(docAction); }
    }

    // Now step forward, storing the before and after state for the table
    // involved in each action.  We'll use this to compute row access changes.
    // For simple changes, the rows will be just the minimal set needed.
    // This could definitely be optimized.  E.g. for pure table updates, these
    // states could be extracted while applying undo actions, with no need for
    // a forward pass.  And for a series of updates to the same table, there'll
    // be duplicated before/after states that could be optimized.
    const steps = new Array<ActionStep>();
    for (const docAction of docActions) {
      const tableId = getTableId(docAction);
      const tableData = docData.getTable(tableId);
      const rowsBefore = cloneDeep(tableData?.getTableDataAction() || ['TableData', '', [], {}] as TableDataAction);
      docData.receiveAction(docAction);
      // If table is deleted, state afterwards doesn't matter.
      const rowsAfter = docData.getTable(tableId) ?
        cloneDeep(tableData?.getTableDataAction() || ['TableData', '', [], {}] as TableDataAction) :
        rowsBefore;
      const step: ActionStep = {action: docAction, rowsBefore, rowsAfter};
      steps.push(step);
    }
    return steps;
  }

  /**
   * Prepare to compute intermediate metadata and rules, as this._metaSteps.
   */
  private async _getUncachedMetaSteps(): Promise<Array<MetaStep>> {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const {docActions, undo, applied} = this._activeBundle;

    const needMeta = docActions.some(a => isSchemaAction(a) || getTableId(a).startsWith('_grist_'));
    if (!needMeta) {
      // Sometimes, the intermediate states are trivial.
      return docActions.map(action => ({action}));
    }
    const metaDocData = new DocData(
      async (tableId) => {
        const result = this._docData.getTable(tableId)?.getTableDataAction();
        if (!result) { throw new Error('surprising load'); }
        return result;
      },
      null,
    );
    // Read the structural tables.
    await Promise.all([...STRUCTURAL_TABLES].map(tableId => metaDocData.syncTable(tableId)));
    if (applied) {
      for (const docAction of [...undo].reverse()) { metaDocData.receiveAction(docAction); }
    }
    let meta = {} as {[key: string]: TableDataAction};
    // Metadata is stored as a hash of TableDataActions.
    for (const tableId of STRUCTURAL_TABLES) {
      meta[tableId] = cloneDeep(metaDocData.getTable(tableId)!.getTableDataAction());
    }

    // Now step forward, tracking metadata and rules through any changes that occur.
    const steps = new Array<MetaStep>();
    let ruler = this._ruler;
    if (applied) {
      // Rules may have changed - back them off to a copy of their original state.
      ruler = new Ruler(this);
      await ruler.update(metaDocData);
    }
    let replaceRuler = false;
    for (const docAction of docActions) {
      const tableId = getTableId(docAction);
      const step: MetaStep = {action: docAction};
      step.metaBefore = meta;
      if (STRUCTURAL_TABLES.has(tableId)) {
        metaDocData.receiveAction(docAction);
        // make shallow copy of all tables
        meta = {...meta};
        // replace table just modified with a deep copy
        meta[tableId] = cloneDeep(metaDocData.getTable(tableId)!.getTableDataAction());
      }
      step.metaAfter = meta;
      // replaceRuler logic avoids updating rules between paired changes of resources and rules.
      if (isAclTable(tableId)) {
        replaceRuler = true;
      } else if (replaceRuler) {
        ruler = new Ruler(this);
        await ruler.update(metaDocData);
        replaceRuler = false;
      }
      step.ruler = ruler;
      steps.push(step);
    }
    return steps;
  }

  /**
   * Return any permitted parts of an action.  A completely forbidden
   * action results in an empty list.  Forbidden columns and rows will
   * be stripped from a returned action.  Rows with forbidden cells are
   * extracted and returned in distinct actions (since they will have
   * a distinct set of columns).
   *
   * This method should only be called with data actions, and will throw
   * for anything else.
   */
  private async _prefilterDocAction(cursor: ActionCursor): Promise<DocAction[]> {
    const {action, docSession} = cursor;
    const tableId = getTableId(action);
    const permInfo = await this._getStepAccess(cursor);
    const tableAccess = permInfo.getTableAccess(tableId);
    const accessCheck = await this._getAccessForActionType(docSession, action, 'check');
    const access = accessCheck.get(tableAccess);
    if (access === 'deny') {
      // Filter out this action entirely.
      return [];
    } else if (access === 'allow') {
      // Retain this action entirely.
      return [action];
    } else if (access === 'mixedColumns') {
      // Retain some or all columns entirely.
      const act = this._pruneColumns(action, permInfo, tableId, accessCheck);
      return act ? [act] : [];
    }
    // The remainder is the mixed condition.

    const {rowsBefore, rowsAfter} = await this._getRowsForRecAndNewRec(cursor);
    const {censoredRows, filteredAction} = await this._filterRowsAndCells({...cursor, action: cloneDeep(action)},
                                                                          rowsBefore, rowsAfter, accessCheck,
                                                                          {allowRowRemoval: true});
    if (filteredAction === null) {
      return [];
    }
    if (!isDataAction(filteredAction)) {
      throw new Error('_prefilterDocAction called with unexpected action');
    }
    if (isRemoveRecordAction(filteredAction)) {
      // removals do not mention columns or cells, so no further complications.
      return [filteredAction];
    }

    // Strip any forbidden columns.
    this._filterColumns(
      filteredAction[3],
      (colId) => accessCheck.get(permInfo.getColumnAccess(tableId, colId)) !== 'deny');
    if (censoredRows.size === 0) {
      // no cell censorship, so no further complications.
      return [filteredAction];
    }

    return filterColValues(filteredAction, (idx) => censoredRows.has(idx), gristTypes.isCensored);
  }

  /**
   * Tailor the information about a change reported to a given client. The action passed in
   * is never modified. The actions output may differ in the following ways:
   *   - Tables, columns or rows may be omitted if the client does not have access to them.
   *   - Columns in structural metadata tables may be cleared if the client does not have
   *     access to the resources they relate to.
   *   - Columns in the _grist_Views table may be cleared or uncleared depending on changes
   *     in other metadata tables.
   *   - Rows may be inserted if the client newly acquires access to them via an update.
   * TODO: I think that column rules controlling READ access using rec are not fully supported
   * yet.  They work on first load, but if READ access is lost/gained updates won't be made.
   */
  private async _filterOutgoingDocAction(cursor: ActionCursor): Promise<DocAction[]> {
    const {action} = cursor;
    const tableId = getTableId(action);
    const permInfo = await this._getStepAccess(cursor);
    const tableAccess = permInfo.getTableAccess(tableId);
    const access = this.getReadPermission(tableAccess);
    const readAccessCheck = this._readAccessCheck(cursor.docSession);
    const results: DocAction[] = [];
    if (access === 'deny') {
      // filter out this data.
    } else if (access === 'allow') {
      results.push(action);
    } else if (access === 'mixedColumns') {
      const act = this._pruneColumns(action, permInfo, tableId, readAccessCheck);
      if (act) { results.push(act); }
    } else {
      // The remainder is the mixed condition.
      for (const act of await this._pruneRows(cursor)) {
        const prunedAct = this._pruneColumns(act, permInfo, tableId, readAccessCheck);
        if (prunedAct) { results.push(prunedAct); }
      }
    }
    const secondPass: DocAction[] = [];
    for (const act of results) {
      if (STRUCTURAL_TABLES.has(getTableId(act)) && isDataAction(act)) {
        await this._filterOutgoingStructuralTables(cursor, act, secondPass);
      } else {
        secondPass.push(act);
      }
    }
    return secondPass;
  }

  private async _filterOutgoingStructuralTables(cursor: ActionCursor, act: DataAction, results: DocAction[]) {
    // Filter out sensitive columns from tables.
    const permissionInfo = await this._getStepAccess(cursor);
    const step = await this._getMetaStep(cursor);
    if (!step.metaAfter) { throw new Error('missing metadata'); }
    act = cloneDeep(act); // Don't change original action.
    const ruler = await this._getRuler(cursor);
    const censor = new CensorshipInfo(permissionInfo,
                                      ruler.ruleCollection,
                                      step.metaAfter,
                                      await this.hasAccessRulesPermission(cursor.docSession));
    if (censor.apply(act)) {
      results.push(act);
    }

    // There's a wrinkle to deal with. If we just added or removed a section, we need to
    // reconsider whether the view containing it is visible.
    if (getTableId(act) === '_grist_Views_section') {
      if (!step.metaBefore) { throw new Error('missing prior metadata'); }
      const censorBefore = new CensorshipInfo(permissionInfo,
                                              ruler.ruleCollection,
                                              step.metaBefore,
                                              await this.hasAccessRulesPermission(cursor.docSession));
      // For all views previously censored, if they are now uncensored,
      // add an UpdateRecord to expose them.
      for (const v of censorBefore.censoredViews) {
        if (!censor.censoredViews.has(v)) {
          const table = step.metaAfter._grist_Views;
          const idx = table[2].indexOf(v);
          const name = table[3].name[idx];
          results.push(['UpdateRecord', '_grist_Views', v, {name}]);
        }
      }
      // For all views currently censored, if they were previously uncensored,
      // add an UpdateRecord to censor them.
      for (const v of censor.censoredViews) {
        if (!censorBefore.censoredViews.has(v)) {
          results.push(['UpdateRecord', '_grist_Views', v, {name: ''}]);
        }
      }
    }
  }

  private async _checkIncomingDocAction(cursor: ActionCursor): Promise<void> {
    const {action, docSession} = cursor;
    const accessCheck = await this._getAccessForActionType(docSession, action, 'fatal');
    const tableId = getTableId(action);
    const permInfo = await this._getStepAccess(cursor);
    const tableAccess = permInfo.getTableAccess(tableId);
    const access = accessCheck.get(tableAccess);
    if (access === 'allow') { return; }
    if (access === 'mixed') {
      // Deal with row-level access for the mixed condition.
      await this._checkRows(cursor, accessCheck);
    }
    // Somewhat abusing prune method by calling it with an access function that
    // throws on denial.
    this._pruneColumns(action, permInfo, tableId, accessCheck);
  }

  private async _getRuler(cursor: ActionCursor) {
    if (cursor.actionIdx === null) { return this._ruler; }
    const step = await this._getMetaStep(cursor);
    return step.ruler || this._ruler;
  }

  private async _getStepAccess(cursor: ActionCursor) {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    if (this._activeBundle.hasAnyRuleChange) {
      const step = await this._getMetaStep(cursor);
      if (step.ruler) { return step.ruler.getAccess(cursor.docSession); }
    }
    // No rule changes!
    return this._getAccess(cursor.docSession);
  }

  private async _getStep(cursor: ActionCursor) {
    if (cursor.actionIdx === null) { throw new Error('No step available'); }
    const steps = await this._getSteps();
    return steps[cursor.actionIdx];
  }

  private async _getMetaStep(cursor: ActionCursor) {
    if (cursor.actionIdx === null) { throw new Error('No step available'); }
    const steps = await this._getMetaSteps();
    return steps[cursor.actionIdx];
  }

  // Get an AccessCheck appropriate for the specific action.
  // TODO: deal with ReplaceTableData, which both deletes and creates rows.
  private async _getAccessForActionType(docSession: OptDocSession, a: DocAction,
                                        severity: 'check'|'fatal'): Promise<IAccessCheck> {
    if (this._hasExceptionalFullAccess(docSession)) {
      return dummyAccessCheck;
    }
    const tableId = getTableId(a);
    if (tableId.startsWith('_grist') && tableId !== '_grist_Attachments') {
      // Actions on any metadata table currently require the schemaEdit flag.
      // Exception: the attachments table, which needs to be reworked to be compatible
      // with granular access.

      // Another exception: ensure owners always have full access to ACL tables, so they
      // can change rules and don't get stuck.
      if (isAclTable(tableId) && await this.isOwner(docSession)) {
        return dummyAccessCheck;
      }
      return accessChecks[severity].schemaEdit;
    } else if (a[0] === 'UpdateRecord' || a[0] === 'BulkUpdateRecord') {
      return accessChecks[severity].update;
    } else if (a[0] === 'RemoveRecord' || a[0] === 'BulkRemoveRecord') {
      return accessChecks[severity].delete;
    } else if (a[0] === 'AddRecord' || a[0] === 'BulkAddRecord') {
      return accessChecks[severity].create;
    } else {
      return accessChecks[severity].schemaEdit;
    }
  }
}

/**
 * A snapshots of rules and permissions at during one of more steps within a bundle.
 */
export class Ruler {
  // The collection of all rules, with helpful accessors.
  public ruleCollection = new ACLRuleCollection();

  // Cache of PermissionInfo associated with the given docSession. It's a WeakMap, so should allow
  // both to be garbage-collected once docSession is no longer in use.
  private _permissionInfoMap = new WeakMap<OptDocSession, Promise<PermissionInfo>>();

  public constructor(private _owner: RulerOwner) {}

  public async getAccess(docSession: OptDocSession): Promise<PermissionInfo> {
    // TODO The intent of caching is to avoid duplicating rule evaluations while processing a
    // single request. Caching based on docSession is riskier since those persist across requests.
    return getSetMapValue(this._permissionInfoMap as Map<OptDocSession, Promise<PermissionInfo>>, docSession,
      async () => new PermissionInfo(this.ruleCollection, {user: await this._owner.getUser(docSession)}));
  }

  public flushAccess(docSession: OptDocSession) {
    this._permissionInfoMap.delete(docSession);
  }

  /**
   * Update granular access from DocData.
   */
  public async update(docData: DocData) {
    await this.ruleCollection.update(docData, {log, compile: compileAclFormula});

    // Also clear the per-docSession cache of rule evaluations.
    this.clearCache();
  }

  public clearCache() {
    this._permissionInfoMap = new WeakMap();
  }

  public haveRules() {
    return this.ruleCollection.haveRules();
  }
}

export interface RulerOwner {
  getUser(docSession: OptDocSession): Promise<UserInfo>;
}

/**
 * Information about a single step within a bundle.  We cache this information to share
 * when filtering output to several clients.
 */
export interface ActionStep {
  action: DocAction;
  rowsBefore: TableDataAction|undefined;  // only defined for actions modifying rows
  rowsAfter: TableDataAction|undefined;   // only defined for actions modifying rows
  rowsLast?: TableDataAction;             // cached calculation of where to point "newRec"
}
export interface MetaStep {
  action: DocAction;
  metaBefore?: {[key: string]: TableDataAction};  // cached structural metadata before action
  metaAfter?: {[key: string]: TableDataAction};   // cached structural metadata after action
  ruler?: Ruler;                          // rules at this step
}

/**
 * A pointer to a particular step within a bundle for a particular session.
 */
interface ActionCursor {
  action: DocAction;
  docSession: OptDocSession;
  actionIdx: number|null;
}

/**
 * A row-like view of TableDataAction, which is columnar in nature.  If index value
 * is undefined, acts as an EmptyRecordRow.
 */
export class RecordView implements InfoView {
  public constructor(public data: TableDataAction, public index: number|undefined) {
  }

  public get(colId: string): CellValue {
    if (this.index === undefined) { return null; }
    if (colId === 'id') {
      return this.data[2][this.index];
    }
    return this.data[3][colId]?.[this.index];
  }

  public has(colId: string) {
    return colId === 'id' || colId in this.data[3];
  }

  public toJSON() {
    if (this.index === undefined) { return {}; }
    const results: {[key: string]: any} = {};
    for (const key of Object.keys(this.data[3])) {
      results[key] = this.data[3][key]?.[this.index];
    }
    return results;
  }
}

/**
 * A read-write view of a DataAction, for use in censorship.
 */
class RecordEditor implements InfoEditor {
  private _rows: number[];
  private _bulk: boolean;
  private _data: ColValues | BulkColValues;
  public constructor(public data: DataAction, public index: number|undefined,
                     public optional: boolean) {
    const rows = data[2];
    this._bulk = Array.isArray(rows);
    this._rows = Array.isArray(rows) ? rows : [rows];
    this._data = data[3] || {};
  }

  public get(colId: string): CellValue {
    if (this.index === undefined) { return null; }
    if (colId === 'id') {
      return this._rows[this.index];
    }
    return this._bulk ?
      (this._data as BulkColValues)[colId][this.index] :
      (this._data as ColValues)[colId];
  }

  public set(colId: string, val: CellValue): this {
    if (this.index === undefined) { throw new Error('cannot set value of non-existent cell'); }
    if (colId === 'id') { throw new Error('cannot change id'); }
    if (this.optional && !(colId in this._data)) { return this; }
    if (this._bulk) {
      (this._data as BulkColValues)[colId][this.index] = val;
    } else {
      (this._data as ColValues)[colId] = val;
    }
    return this;
  }

  public toJSON() {
    if (this.index === undefined) { return {}; }
    const results: {[key: string]: any} = {};
    for (const key of Object.keys(this._data)) {
      results[key] = this.get(key);
    }
    return results;
  }
}

class EmptyRecordView implements InfoView {
  public get(colId: string): CellValue { return null; }
  public toJSON() { return {}; }
}

/**
 * Cache information about user attributes.
 */
class UserAttributes {
  public rows: {[clauseName: string]: InfoView} = {};
  public override?: UserOverride;
}

interface IAccessCheck {
  get(ps: PermissionSetWithContext): string;
  throwIfDenied(ps: PermissionSetWithContext): void;
  throwIfNotFullyAllowed(ps: PermissionSetWithContext): void;
}

class AccessCheck implements IAccessCheck {
  constructor(public access: 'update'|'delete'|'create'|'schemaEdit'|'read',
              public severity: 'check'|'fatal') {
  }

  public get(ps: PermissionSetWithContext): string {
    const result = ps.perms[this.access];
    if (result !== 'deny' || this.severity !== 'fatal') { return result; }
    this.throwIfDenied(ps);
    return result;
  }

  public throwIfDenied(ps: PermissionSetWithContext): void {
    const result = ps.perms[this.access];
    if (result !== 'deny') { return; }
    this._throwError(ps);
  }

  public throwIfNotFullyAllowed(ps: PermissionSetWithContext): void {
    const result = ps.perms[this.access];
    if (result === 'allow') { return; }
    this._throwError(ps);
  }

  private _throwError(ps: PermissionSetWithContext): void {
    const memos = ps.getMemos()[this.access];
    const label =
      this.access === 'schemaEdit' ? 'structure' :
      this.access;
    throw new ErrorWithCode('ACL_DENY', `Blocked by ${ps.ruleType} ${label} access rules`, {
      memos,
      status: 403
    });
  }
}

export const accessChecks = {
  check: fromPairs(ALL_PERMISSION_PROPS.map(prop => [prop, new AccessCheck(prop, 'check')])),
  fatal: fromPairs(ALL_PERMISSION_PROPS.map(prop => [prop, new AccessCheck(prop, 'fatal')])),
};


// This AccessCheck allows everything.
const dummyAccessCheck: IAccessCheck = {
  get() { return 'allow'; },
  throwIfDenied() {},
  throwIfNotFullyAllowed() {}
};


/**
 * Manage censoring metadata.
 *
 * For most metadata, censoring means blanking out certain fields, rather than removing rows,
 * (because the latter was too big of a change). In particular, these changes are relied on by
 * other code:
 *
 *  - Censored tables (from _grist_Tables) have cleared tableId field. To check for it, use the
 *    isTableCensored() helper in app/common/isHiddenTable.ts. This is used by exports to Excel.
 */
export class CensorshipInfo {
  public censoredTables = new Set<number>();
  public censoredSections = new Set<number>();
  public censoredViews = new Set<number>();
  public censoredColumns = new Set<number>();
  public censoredFields = new Set<number>();
  public censored = {
    _grist_Tables: this.censoredTables,
    _grist_Tables_column: this.censoredColumns,
    _grist_Views: this.censoredViews,
    _grist_Views_section: this.censoredSections,
    _grist_Views_section_field: this.censoredFields,
  };

  public constructor(permInfo: PermissionInfo,
                     ruleCollection: ACLRuleCollection,
                     tables: {[key: string]: TableDataAction},
                     private _canViewACLs: boolean) {
    // Collect a list of censored columns (by "<tableRef> <colId>").
    const columnCode = (tableRef: number, colId: string) => `${tableRef} ${colId}`;
    const censoredColumnCodes: Set<string> = new Set();
    const tableRefToTableId: Map<number, string> = new Map();
    const tableRefToIndex: Map<number, number> = new Map();
    const uncensoredTables: Set<number> = new Set();
    // Scan for forbidden tables.
    let rec = new RecordView(tables._grist_Tables, undefined);
    let ids = getRowIdsFromDocAction(tables._grist_Tables);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      const tableId = rec.get('tableId') as string;
      const tableRef = ids[idx];
      tableRefToTableId.set(tableRef, tableId);
      tableRefToIndex.set(tableRef, idx);
      const tableAccess = permInfo.getTableAccess(tableId);
      if (tableAccess.perms.read === 'deny') {
        this.censoredTables.add(tableRef);
      } else if (tableAccess.perms.read === 'allow') {
        uncensoredTables.add(tableRef);
      }
    }
    // Scan for forbidden columns.
    ids = getRowIdsFromDocAction(tables._grist_Tables_column);
    rec = new RecordView(tables._grist_Tables_column, undefined);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      const tableRef = rec.get('parentId') as number;
      if (uncensoredTables.has(tableRef)) { continue; }
      const tableId = tableRefToTableId.get(tableRef);
      if (!tableId) { throw new Error('table not found'); }
      const colId = rec.get('colId') as string;
      if (this.censoredTables.has(tableRef) ||
          (colId !== 'manualSort' && permInfo.getColumnAccess(tableId, colId).perms.read === 'deny')) {
        censoredColumnCodes.add(columnCode(tableRef, colId));
      }
    }
    // Collect a list of all sections and views containing a table to which the user has no access.
    rec = new RecordView(tables._grist_Views_section, undefined);
    ids = getRowIdsFromDocAction(tables._grist_Views_section);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      if (!this.censoredTables.has(rec.get('tableRef') as number)) { continue; }
      const parentId = rec.get('parentId') as number;
      if (parentId) { this.censoredViews.add(parentId); }
      this.censoredSections.add(ids[idx]);
    }
    // Collect a list of all columns from tables to which the user has no access.
    rec = new RecordView(tables._grist_Tables_column, undefined);
    ids = getRowIdsFromDocAction(tables._grist_Tables_column);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      const parentId = rec.get('parentId') as number;
      if (this.censoredTables.has(parentId) ||
          censoredColumnCodes.has(columnCode(parentId, rec.get('colId') as string))) {
        this.censoredColumns.add(ids[idx]);
      }
    }
    // Collect a list of all fields from sections to which the user has no access.
    rec = new RecordView(tables._grist_Views_section_field, undefined);
    ids = getRowIdsFromDocAction(tables._grist_Views_section_field);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      if (!this.censoredSections.has(rec.get('parentId') as number) &&
          !this.censoredColumns.has(rec.get('colRef') as number)) { continue; }
      this.censoredFields.add(ids[idx]);
    }

    // Now undo some of the above...
    // Specifically, when a summary table is not censored, uncensor the source table's raw view section,
    // so that the user can see the source table's title,
    // which is used to construct the summary table's title. The section's fields remain censored.
    // This would also be a sensible place to uncensor the source tableId, but that causes other problems.
    rec = new RecordView(tables._grist_Tables, undefined);
    ids = getRowIdsFromDocAction(tables._grist_Tables);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      const tableRef = ids[idx];
      const sourceTableRef = rec.get('summarySourceTable') as number;
      const sourceTableIndex = tableRefToIndex.get(sourceTableRef);
      if (
        this.censoredTables.has(tableRef) ||
        !sourceTableRef ||
        sourceTableIndex === undefined ||
        !this.censoredTables.has(sourceTableRef)
      ) { continue; }
      rec.index = sourceTableIndex;
      const rawViewSectionRef = rec.get('rawViewSectionRef') as number;
      this.censoredSections.delete(rawViewSectionRef);
    }
  }

  public apply(a: DataAction) {
    const tableId = getTableId(a);
    const ids = getRowIdsFromDocAction(a);
    if (!STRUCTURAL_TABLES.has(tableId)) { return true; }
    if (!(tableId in this.censored)) {
      if (!this._canViewACLs && a[0] === 'TableData') {
        a[2] = [];
        a[3] = {};
      }
      return this._canViewACLs;
    }
    const rec = new RecordEditor(a, undefined, true);
    const method = getCensorMethod(getTableId(a));
    const censoredRows = (this.censored as any)[tableId] as Set<number>;
    for (const [index, id] of ids.entries()) {
      if (censoredRows.has(id)) {
        rec.index = index;
        method(rec);
      }
    }
    return true;
  }
}

function getCensorMethod(tableId: string): (rec: RecordEditor) => void {
  switch (tableId) {
    case '_grist_Tables':
      return rec => rec.set('tableId', '');
    case '_grist_Views':
      return rec => rec.set('name', '');
    case '_grist_Views_section':
      return rec => rec.set('title', '').set('tableRef', 0);
    case '_grist_Tables_column':
      return rec => rec.set('label', '').set('colId', '').set('widgetOptions', '')
        .set('formula', '').set('type', 'Any').set('parentId', 0);
    case '_grist_Views_section_field':
      return rec => rec.set('widgetOptions', '').set('filter', '').set('parentId', 0);
    case '_grist_ACLResources':
      return rec => rec;
    case '_grist_ACLRules':
      return rec => rec;
    default:
      throw new Error(`cannot censor ${tableId}`);
  }
}

function scanActionsRecursively(actions: (DocAction|UserAction)[],
                                check: (action: DocAction|UserAction) => boolean): boolean {
  for (const a of actions) {
    if (a[0] === 'ApplyUndoActions' || a[0] === 'ApplyDocActions') {
      return scanActionsRecursively(a[1] as UserAction[], check);
    }
    if (check(a)) { return true; }
  }
  return false;
}

async function applyToActionsRecursively(actions: (DocAction|UserAction)[],
                                         op: (action: DocAction|UserAction) => Promise<void>): Promise<void> {
  for (const a of actions) {
    if (a[0] === 'ApplyUndoActions' || a[0] === 'ApplyDocActions') {
      await applyToActionsRecursively(a[1] as UserAction[], op);
    }
    await op(a);
  }
}

/**
 * Takes an action, and removes certain cells from it.  The action
 * passed in is modified in place, and also returned as part of a list
 * of derived actions.
 *
 * For a non-bulk action, any cell values that return true for
 * shouldFilterCell are removed.  For a bulk action, there's no way to
 * express that in general in a single action.  For a bulk action, for
 * any row (identified by row index, not rowId) that returns true for
 * shouldFilterRow, we remove cell values based on shouldFilterCell
 * and add the row to an action with just the remaining cell values.
 *
 * This is by no means a general-purpose function.  It is used only in
 * the implementation of partial undos.  If is factored out for
 * testing purposes.
 *
 * This method could be made unnecessary if a way were created to have
 * unambiguous "holes" in column value arrays, where values for some
 * rows are omitted.
 */
export function filterColValues(action: DataAction,
                                shouldFilterRow: (idx: number) => boolean,
                                shouldFilterCell: (value: CellValue) => boolean): DataAction[] {
  if (isRemoveRecordAction(action)) {
    // removals do not have cells, so nothing to do.
    return [action];
  }

  const colIds = Object.keys(action[3]).sort();
  const colValues = action[3];

  if (!isBulkAction(action)) {
    for (const colId of colIds) {
      if (shouldFilterCell((colValues as ColValues)[colId])) {
        delete colValues[colId];
      }
    }
    return [action];
  }

  const rowIds = action[2];

  // For bulk operations, censored cells require us to reorganize into a set of actions
  // with different columns.
  const parts: Map<string, typeof action> = new Map();
  let at = 0;
  for (let idx = 0; idx < rowIds.length; idx++) {
    if (!shouldFilterRow(idx)) {
      if (idx !== at) {
        // Shuffle columnar data up as we remove rows.
        rowIds[at] = rowIds[idx];
        for (const colId of colIds) {
          (colValues as BulkColValues)[colId][at] = (colValues as BulkColValues)[colId][idx];
        }
      }
      at++;
      continue;
    }
    // Some censored data in this row, so move the row to an action specialized
    // for the set of columns this row has.
    const keys: string[] = [];
    const values: BulkColValues = {};
    for (const colId of colIds) {
      const value = (colValues as BulkColValues)[colId][idx];
      if (!shouldFilterCell(value)) {
        values[colId] = [value];
        keys.push(colId);
      }
    }
    const mergedKey = keys.join(' ');
    const peers = parts.get(mergedKey);
    if (!peers) {
      parts.set(mergedKey, [action[0], action[1], [rowIds[idx]], values]);
    } else {
      peers[2].push(rowIds[idx]);
      for (const key of keys) {
        peers[3][key].push(values[key][0]);
      }
    }
  }
  // Truncate columnar data.
  rowIds.length = at;
  for (const colId of colIds) {
    (colValues as BulkColValues)[colId].length = at;
  }
  // Return all actions, in a consistent order for test purposes.
  return [action, ...[...parts.keys()].sort().map(key => parts.get(key)!)];
}

/**
 * Information about a user, including any user attributes.
 *
 * Serializes into a more compact JSON form that excludes full
 * row data, only keeping user info and table/row ids for any
 * user attributes.
 *
 * See `user.py` for the sandbox equivalent that deserializes objects of this class.
 */
export class User implements UserInfo {
  public Name: string | null = null;
  public UserID: number | null = null;
  public Access: Role | null = null;
  public Origin: string | null = null;
  public LinkKey: Record<string, string | undefined> = {};
  public Email: string | null = null;
  [attribute: string]: any;

  constructor(_info: Record<string, unknown> = {}) {
    Object.assign(this, _info);
  }

  public toJSON() {
    const results: {[key: string]: any} = {};
    for (const [key, value] of Object.entries(this)) {
      if (value instanceof RecordView) {
        // Only include the table id and first matching row id.
        results[key] = [getTableId(value.data), value.get('id')];
      } else if (value instanceof EmptyRecordView) {
        results[key] = null;
      } else {
        results[key] = value;
      }
    }
    return results;
  }
}

export function validTableIdString(tableId: any): string {
  if (typeof tableId !== 'string') { throw new Error(`Expected tableId to be a string`); }
  return tableId;
}
