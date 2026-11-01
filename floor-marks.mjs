export const FLOOR_MARK_KEY = 'huoxiaqu';
const clone = value => structuredClone(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0;
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value);
const pageId = row => row?.swipe_id ?? 0;
const requireValue = (ok, reason) => { if (!ok) throw Error(reason); };
export const floorSourceText = value => String(value ?? '')
  .replaceAll('<StatusPlaceHolderImpl/>', '')
  .replaceAll(/<(status_current_variable)>(?:(?!<\1>).)*<\/\1?>/gis, '').trimEnd();

export function readFloorMark(row) {
  const root = row?.extra?.[FLOOR_MARK_KEY];
  const page = pageId(row);
  const mark = root?.pages?.[String(page)];
  if (root?.version !== 1 || !text(root.uid) || !integer(page)
      || mark?.sourceText !== floorSourceText(row.mes) || !Array.isArray(mark.events)) return null;
  return { uid: root.uid, page, events: clone(mark.events) };
}

function target(records, index, swipeId, mint) {
  requireValue(Array.isArray(records) && records[0]?.chat_metadata && integer(index), 'FLOOR_PREPARED_RECORDS_REQUIRED');
  const row = records[index + 1];
  requireValue(row && integer(swipeId) && pageId(row) === swipeId && typeof row.mes === 'string', 'FLOOR_SELECTED_PAGE_CHANGED');
  const old = row.extra?.[FLOOR_MARK_KEY];
  requireValue(!old || old.version === 1 && text(old.uid) && old.pages && typeof old.pages === 'object', 'FLOOR_FOREIGN_MARK');
  const uid = old?.uid ?? mint?.();
  requireValue(text(uid), 'FLOOR_UID_REQUIRED');
  const root = old ? clone(old) : { version: 1, uid, pages: {} };
  const previous = root.pages[String(swipeId)];
  const sourceText = floorSourceText(row.mes);
  const page = previous?.sourceText === sourceText ? clone(previous) : { sourceText, events: [] };
  requireValue(Array.isArray(page.events), 'FLOOR_EVENTS_INVALID');
  return { row, root, page, uid, swipeId };
}

function put(t, event) {
  const same = e => e.kind === event.kind && (e.kind === 'checkpoint' ? e.archiveKey === event.archiveKey : true);
  t.page.events = t.page.events.filter(e => !same(e));
  t.page.events.push(clone(event));
  t.root.pages[String(t.swipeId)] = t.page;
  t.row.extra = { ...t.row.extra, [FLOOR_MARK_KEY]: t.root };
  if (Array.isArray(t.row.swipe_info) && t.row.swipe_info[t.swipeId]) {
    t.row.swipe_info[t.swipeId].extra = { ...t.row.swipe_info[t.swipeId].extra, [FLOOR_MARK_KEY]: clone(t.root) };
  }
  return { uid: t.uid, swipeId: t.swipeId, sourceText: t.page.sourceText, kind: event.kind, written: true, persisted: false };
}

export function stageCheckpointMark(records, spec, mint) {
  const { index, swipeId = 0, archiveKey, gameTime, timelineId, sourceSpan, location } = spec;
  requireValue(/^档[1-9]\d*$/.test(archiveKey) && time(gameTime) && integer(timelineId)
    && ['whole', 'mixed'].includes(sourceSpan) && text(location), 'FLOOR_CHECKPOINT_SPEC_INVALID');
  const state = records?.[0]?.chat_metadata?.死亡回归存档?.快照?.[archiveKey];
  requireValue(state?.顶层?.时间 === gameTime && state.顶层.地点 === location, 'FLOOR_ARCHIVE_STATE_MISMATCH');
  const t = target(records, index, swipeId, mint);
  return put(t, { kind: 'checkpoint', archiveKey, gameTime, timelineId, sourceSpan, location });
}

export function stageDeathMark(records, spec, mint) {
  const { index, swipeId = 0, gameTime, timelineId } = spec;
  requireValue(time(gameTime) && integer(timelineId), 'FLOOR_DEATH_SPEC_INVALID');
  const t = target(records, index, swipeId, mint);
  requireValue(t.row.is_user !== true && t.row.extra?.回归存档点 !== true, 'FLOOR_DEATH_ASSISTANT_REQUIRED');
  return put(t, { kind: 'death', gameTime, timelineId });
}

export function stageReturnMark(records, spec, mint) {
  const { index, swipeId = 0, archiveKey, deathSource, newTimelineId, gameTime } = spec;
  requireValue(/^档[1-9]\d*$/.test(archiveKey) && text(deathSource?.uid)
    && integer(deathSource.swipeId) && typeof deathSource.sourceText === 'string' && integer(newTimelineId)
    && time(gameTime), 'FLOOR_RETURN_SPEC_INVALID');
  const t = target(records, index, swipeId, mint);
  requireValue(t.row.is_user !== true, 'FLOOR_RETURN_ASSISTANT_REQUIRED');
  return put(t, { kind: 'return', archiveKey, deathSource: clone(deathSource), gameTime, timelineId: newTimelineId });
}
