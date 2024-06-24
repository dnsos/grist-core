import {BulkColValues, ColValues, DocAction, isSchemaAction, TableDataAction, UserAction} from 'app/common/DocActions';
import {DocData} from 'app/common/DocData';
import {TableData} from 'app/common/TableData';
import {IndexColumns} from 'app/server/lib/DocStorage';

const ACTION_TYPES = new Set(['AddRecord', 'BulkAddRecord', 'UpdateRecord', 'BulkUpdateRecord',
  'RemoveRecord', 'BulkRemoveRecord']);

export interface ProcessedAction {
  stored: DocAction[];
  undo: DocAction[];
  retValues: any;
}

export interface OnDemandStorage {
  getNextRowId(tableId: string): Promise<number>;
  fetchActionData(tableId: string, rowIds: number[], colIds?: string[]): Promise<TableDataAction>;
}

/**
 * Handle converting UserActions to DocActions for onDemand tables.
 */
export class OnDemandActions {

  private _tablesMeta: TableData = this._docData.getMetaTable('_grist_Tables');
  private _columnsMeta: TableData = this._docData.getMetaTable('_grist_Tables_column');

  constructor(private _storage: OnDemandStorage, private _docData: DocData,
              private _forceOnDemand: boolean = false) {}

  // TODO: Ideally a faster data structure like an index by tableId would be used to decide whether
  // the table is onDemand.
  public isOnDemand(tableId: string): boolean {
    if (this._forceOnDemand) { return true; }
    const tableRef = this._tablesMeta.findRow('tableId', tableId);
    // OnDemand tables must have a record in the _grist_Tables metadata table.
    return tableRef ? Boolean(this._tablesMeta.getValue(tableRef, 'onDemand')) : false;
  }

  /**
   * Convert a UserAction into stored and undo DocActions as well as return values.
   */
  public processUserAction(action: UserAction): Promise<ProcessedAction> {
    const a = action.map(item => item as any);
    switch (a[0]) {
      case "ApplyUndoActions": return this._doApplyUndoActions(a[1]);
      case "AddRecord":        return this._doAddRecord       (a[1], a[2], a[3]);
      case "BulkAddRecord":    return this._doBulkAddRecord   (a[1], a[2], a[3]);
      case "UpdateRecord":     return this._doUpdateRecord    (a[1], a[2], a[3]);
      case "BulkUpdateRecord": return this._doBulkUpdateRecord(a[1], a[2], a[3]);
      case "RemoveRecord":     return this._doRemoveRecord    (a[1], a[2]);
      case "BulkRemoveRecord": return this._doBulkRemoveRecord(a[1], a[2]);
      default: throw new Error(`Received unknown action ${action[0]}`);
    }
  }

  /**
   * Splits an array of UserActions into two separate arrays of normal and onDemand actions.
   */
  public splitByOnDemand(actions: UserAction[]): [UserAction[], UserAction[]] {
    const normal: UserAction[] = [];
    const onDemand: UserAction[] = [];
    actions.forEach(a => {
      // Check that the actionType can be applied without the sandbox and also that the action
      // is on a data table.
      const isOnDemandAction = ACTION_TYPES.has(a[0] as string);
      const isDataTableAction = typeof a[1] === 'string' && !a[1].startsWith('_grist_');
      if (a[0] === 'ApplyUndoActions') {
        // Split actions inside the undo action array.
        const [undoNormal, undoOnDemand] = this.splitByOnDemand(a[1] as UserAction[]);
        if (undoNormal.length > 0) {
          normal.push(['ApplyUndoActions', undoNormal]);
        }
        if (undoOnDemand.length > 0) {
          onDemand.push(['ApplyUndoActions', undoOnDemand]);
        }
      } else if (isDataTableAction && isOnDemandAction && this.isOnDemand(a[1] as string)) {
        // Check whether the tableId belongs to an onDemand table.
        onDemand.push(a);
      } else {
        normal.push(a);
      }
    });
    return [normal, onDemand];
  }

  /**
   * Compute the indexes we would like to have, given the current schema.
   */
  public getDesiredIndexes(): IndexColumns[] {
    const desiredIndexes: IndexColumns[] = [];
    for (const c of this._columnsMeta.getRecords()) {
      const t = this._tablesMeta.getRecord(c.parentId as number);
      if (t && t.onDemand && c.type && (c.type as string).startsWith('Ref:')) {
        desiredIndexes.push({tableId: t.tableId as string, colId: c.colId as string});
      }
    }
    return desiredIndexes;
  }

  /**
   * Check if an action represents a schema change on an onDemand table.
   */
  public isSchemaAction(docAction: DocAction): boolean {
   return isSchemaAction(docAction) && this.isOnDemand(docAction[1]);
  }

  private async _doApplyUndoActions(actions: DocAction[]) {
    const undo: DocAction[] = [];
    for (const a of actions) {
      const converted = await this.processUserAction(a);
      undo.concat(converted.undo);
    }
    return {
      stored: actions,
      undo,
      retValues: null
    };
  }

  private async _doAddRecord(
    tableId: string,
    rowId: number|null,
    colValues: ColValues
  ): Promise<ProcessedAction> {
    if (rowId === null) {
      rowId = await this._storage.getNextRowId(tableId);
    }
    // Set the manualSort to be the same as the rowId. This forces new rows to always be added
    // at the end of the table.
    colValues.manualSort = rowId;
    return {
      stored: [['AddRecord', tableId, rowId, colValues]],
      undo: [['RemoveRecord', tableId, rowId]],
      retValues: rowId
    };
  }

  private async _doBulkAddRecord(
    tableId: string,
    rowIds: Array<number|null>,
    colValues: BulkColValues
  ): Promise<ProcessedAction> {

    // When unset, we will set the rowId values to count up from the greatest
    // values already in the table.
    if (rowIds[0] === null) {
      const nextRowId = await this._storage.getNextRowId(tableId);
      for (let i = 0; i < rowIds.length; i++) {
        rowIds[i] = nextRowId + i;
      }
    }
    // Set the manualSort values to be the same as the rowIds. This forces new rows to always be
    // added at the end of the table.
    colValues.manualSort = rowIds;
    return {
      stored: [['BulkAddRecord', tableId, rowIds as number[], colValues]],
      undo: [['BulkRemoveRecord', tableId, rowIds as number[]]],
      retValues: rowIds
    };
  }

  private async _doUpdateRecord(
    tableId: string,
    rowId: number,
    colValues: ColValues
  ): Promise<ProcessedAction> {
    const [, , oldRowIds, oldColValues] =
      await this._storage.fetchActionData(tableId, [rowId], Object.keys(colValues));
    return {
      stored: [['UpdateRecord', tableId, rowId, colValues]],
      undo: [['BulkUpdateRecord', tableId, oldRowIds, oldColValues]],
      retValues: null
    };
  }

  private async _doBulkUpdateRecord(
    tableId: string,
    rowIds: number[],
    colValues: BulkColValues
  ): Promise<ProcessedAction> {
    const [, , oldRowIds, oldColValues] =
      await this._storage.fetchActionData(tableId, rowIds, Object.keys(colValues));
    return {
      stored: [['BulkUpdateRecord', tableId, rowIds, colValues]],
      undo: [['BulkUpdateRecord', tableId, oldRowIds, oldColValues]],
      retValues: null
    };
  }

  private async _doRemoveRecord(tableId: string, rowId: number): Promise<ProcessedAction> {
    const [, , oldRowIds, oldColValues] = await this._storage.fetchActionData(tableId, [rowId]);
    return {
      stored: [['RemoveRecord', tableId, rowId]],
      undo: [['BulkAddRecord', tableId, oldRowIds, oldColValues]],
      retValues: null
    };
  }

  private async _doBulkRemoveRecord(tableId: string, rowIds: number[]): Promise<ProcessedAction> {
    const [, , oldRowIds, oldColValues] = await this._storage.fetchActionData(tableId, rowIds);
    return {
      stored: [['BulkRemoveRecord', tableId, rowIds]],
      undo: [['BulkAddRecord', tableId, oldRowIds, oldColValues]],
      retValues: null
    };
  }
}
