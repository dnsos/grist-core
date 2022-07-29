import type {AppModel} from 'app/client/models/AppModel';
import {commonUrls} from 'app/common/gristUrls';
import {Disposable, DomContents, IDisposableOwner, Observable, observable} from 'grainjs';

export function buildNewSiteModal(context: Disposable, options: {
  planName: string,
  onCreate?: () => void
}) {
  window.location.href = commonUrls.plans;
}

export function buildUpgradeModal(owner: Disposable, planName: string)  {
  window.location.href = commonUrls.plans;
}

export function showTeamUpgradeConfirmation(owner: Disposable) {
}

export interface UpgradeButton  {
  showUpgradeCard(): DomContents;
  showUpgradeButton(): DomContents;
}

export function buildUpgradeButton(owner: IDisposableOwner, app: AppModel): UpgradeButton {
  return {
    showUpgradeCard : () => null,
    showUpgradeButton : () => null,
  };
}

export function NEW_DEAL(): Observable<boolean> {
  return observable(false);
}