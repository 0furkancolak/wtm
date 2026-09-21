import { SQLiteStateStore } from '../sqlite-store';

function open(): SQLiteStateStore {
  return new SQLiteStateStore(':memory:');
}

function setsAndReads() {
  const store = open();
  try {
    const { checklist } = store;
    const items = checklist.set('wt-1', ['Check login', 'Run migration'], '2026-09-21T12:00:00.000Z');
    const listed = checklist.list('wt-1');
    return {
      items: items.map(({ position, text, checked, createdAt, updatedAt }) => ({ position, text, checked, createdAt, updatedAt })),
      listedMatchesSet: JSON.stringify(listed) === JSON.stringify(items),
      emptyForOtherWorktree: checklist.list('wt-2').length,
    };
  } finally {
    store.close();
  }
}

function setReplacesWholeListAndResetsChecked() {
  const store = open();
  try {
    const { checklist } = store;
    checklist.set('wt-1', ['First', 'Second'], '2026-09-21T12:00:00.000Z');
    checklist.setChecked('wt-1', 0, true, '2026-09-21T12:01:00.000Z');
    const replaced = checklist.set('wt-1', ['Only item'], '2026-09-21T12:05:00.000Z');
    return {
      replacedTexts: replaced.map(({ text }) => text),
      replacedAllUnchecked: replaced.every((item) => item.checked === false),
      replacedLength: replaced.length,
    };
  } finally {
    store.close();
  }
}

function setChecksTogglesByPosition() {
  const store = open();
  try {
    const { checklist } = store;
    checklist.set('wt-1', ['First', 'Second'], '2026-09-21T12:00:00.000Z');
    const toggled = checklist.setChecked('wt-1', 1, true, '2026-09-21T12:02:00.000Z');
    const missing = checklist.setChecked('wt-1', 9, true, '2026-09-21T12:02:00.000Z');
    const listed = checklist.list('wt-1');
    return {
      toggledChecked: toggled?.checked,
      toggledUpdatedAt: toggled?.updatedAt,
      missingIsNull: missing === null,
      secondIsChecked: listed[1]?.checked,
      firstStillUnchecked: listed[0]?.checked === false,
    };
  } finally {
    store.close();
  }
}

function clearAndDeleteForWorktree() {
  const store = open();
  try {
    const { checklist } = store;
    checklist.set('wt-1', ['First', 'Second'], '2026-09-21T12:00:00.000Z');
    checklist.set('wt-2', ['Other'], '2026-09-21T12:00:00.000Z');
    const cleared = checklist.clear('wt-1');
    const wt1AfterClear = checklist.list('wt-1').length;
    checklist.set('wt-1', ['Back again'], '2026-09-21T12:10:00.000Z');
    const deleted = checklist.deleteForWorktree('wt-1');
    return {
      cleared, wt1AfterClear, deleted,
      wt1AfterDelete: checklist.list('wt-1').length,
      wt2Survives: checklist.list('wt-2').length,
    };
  } finally {
    store.close();
  }
}

function trimsAndCapsItems() {
  const store = open();
  try {
    const { checklist } = store;
    const items = checklist.set('wt-1', ['  padded text  ', '', '   '], '2026-09-21T12:00:00.000Z');
    return {
      // Blank/whitespace-only entries are dropped, so two of the three inputs vanish.
      count: items.length,
      firstText: items[0]?.text,
      firstPosition: items[0]?.position,
    };
  } finally {
    store.close();
  }
}

const scenarios: Record<string, () => unknown> = {
  'sets-and-reads': setsAndReads,
  'set-replaces-whole-list-and-resets-checked': setReplacesWholeListAndResetsChecked,
  'set-checked-toggles-by-position': setChecksTogglesByPosition,
  'clear-and-delete-for-worktree': clearAndDeleteForWorktree,
  'trims-and-caps-items': trimsAndCapsItems,
};

const scenarioName = process.argv[2];
const scenario = scenarioName === undefined ? undefined : scenarios[scenarioName];
if (scenario === undefined) throw new Error(`Unknown scenario: ${scenarioName ?? '<missing>'}`);
process.stdout.write(`${JSON.stringify(scenario())}\n`);
