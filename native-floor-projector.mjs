import { readFloorMark, floorSourceText } from './floor-marks.mjs';
const clone = value => structuredClone(value);
const ignore = Symbol.for('ignore');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const selectedPage = row => row?.swipe_id ?? 0;
const sameSource = (mark, row, source) => mark?.uid === source?.uid
  && mark.page === source.swipeId && floorSourceText(row.mes) === floorSourceText(source.sourceText);
const note = mes => ({ name: 'Narrator', is_user: false, is_system: false,
  mes, extra: { type: 'narrator' } });
const unavailable = code => ({ available: false, code, rows: null });

export function projectNativeFloors(coreChat, context, { type = 'normal', formatHidden = null } = {}) {
  if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return unavailable('FLOOR_NON_NARRATIVE');
  if (!Array.isArray(coreChat) || !Array.isArray(context?.chat) || !context.getCurrentChatId?.()) return unavailable('FLOOR_CONTEXT_MISSING');
  const chat = context.chat;
  const marked = chat.map((row, index) => ({ row, index, mark: readFloorMark(row) })).filter(x => x.mark);
  if (!marked.length) return unavailable('FLOOR_NO_COMMITTED_MARKS');
  if (chat.some(row => row?.is_system && Array.isArray(row.extra?.tool_invocations))) return unavailable('FLOOR_TOOL_CONTEXT_UNSUPPORTED');
  const visible = chat.map((row, index) => ({ row, index })).filter(x => !x.row.is_system);
  const units = [], seen = new Set();
  for (const raw of coreChat) {
    if (!integer(raw.index) || seen.has(raw.index)) return unavailable('FLOOR_NATIVE_INDEX_UNPROVEN');
    seen.add(raw.index);
    const src = visible[raw.index];
    if (!src || src.row.extra !== raw.extra || src.row.is_user !== raw.is_user
      || src.row.name !== raw.name || src.row.send_date !== raw.send_date
      || selectedPage(src.row) !== selectedPage(raw)) return unavailable('FLOOR_NATIVE_SOURCE_CHANGED');
    if (!raw.extra?.[ignore]) units.push({ ...src, raw, restored: false });
  }
  if (!units.length) return unavailable('FLOOR_EMPTY_VISIBLE_WINDOW');
  const min = Math.min(...units.map(x => x.index)), max = Math.max(...units.map(x => x.index));
  const events = marked.flatMap(item => item.mark.events.map(event => ({ ...item, event })));
  const archives = new Map(), deaths = new Map();
  for (const item of events) {
    if (item.event.kind === 'checkpoint') {
      if (archives.has(item.event.archiveKey)) return unavailable('FLOOR_ARCHIVE_SOURCE_AMBIGUOUS');
      archives.set(item.event.archiveKey, item);
    }
    if (item.event.kind === 'death') {
      if (deaths.has(item.mark.uid)) return unavailable('FLOOR_DEATH_SOURCE_AMBIGUOUS');
      deaths.set(item.mark.uid, item);
    }
  }
  const allReturns = events.filter(x => x.event.kind === 'return');
  if (type === 'continue' && allReturns.at(-1)?.index > max) return unavailable('FLOOR_CONTINUE_TARGET_BEFORE_RETURN');
  const returns = allReturns.filter(x => x.index <= max);
  for (const item of returns) {
    const cp = archives.get(item.event.archiveKey), death = deaths.get(item.event.deathSource?.uid);
    if (!cp || !death || !sameSource(death.mark, death.row, item.event.deathSource)
      || cp.index > death.index || death.index >= item.index
      || cp.event.gameTime !== item.event.gameTime) return unavailable('FLOOR_RETURN_SOURCES_UNPROVEN');
    item.checkpoint = cp;
    item.death = death;
  }
  const latestReturn = returns.at(-1);
  const isOldIndex = index => returns.some(r => index === r.death.index || index <= r.death.index
    && (index > r.checkpoint.index || index === r.checkpoint.index && r.checkpoint.event.sourceSpan === 'mixed'));
  const anchors = [...archives.values()].filter(cp => cp.index <= max && !isOldIndex(cp.index));
  // A mixed source belongs to old experience after a return, but its exact checkpoint
  // still establishes the start of the now-proven suffix.
  if (latestReturn) anchors.push(latestReturn.checkpoint);
  const anchor = anchors.length ? Math.max(...anchors.map(cp => cp.index)) : null;
  const legacyIndices = chat.flatMap((row, index) => row?.extra?.回归存档点 === true
    && !readFloorMark(row)?.events.some(e => e.kind === 'checkpoint' || e.kind === 'return') ? [index] : []);
  const legacyPresent = legacyIndices.length > 0;
  if (legacyPresent && (anchor === null || legacyIndices.some(index =>
    index >= anchor && index <= max && !isOldIndex(index)
    || type === 'continue' && index > max))) return unavailable('FLOOR_LEGACY_BOUNDARY_NOT_MIGRATED');
  const needed = new Set(events.filter(x => x.index >= min && x.index <= max).map(x => x.index));
  if (latestReturn) needed.add(latestReturn.checkpoint.index);
  const byIndex = new Map(units.map(unit => [unit.index, unit]));
  for (const index of needed) {
    const item = marked.find(x => x.index === index);
    if (!item || byIndex.has(index) || item.row.is_user) continue;
    const cp = item.mark.events.find(e => e.kind === 'checkpoint');
    const death = item.mark.events.find(e => e.kind === 'death');
    if (!cp && !death) continue;
    if (index < min && cp?.sourceSpan === 'mixed' && !death) continue;
    if (typeof formatHidden !== 'function') return unavailable('FLOOR_HIDDEN_FORMATTER_REQUIRED');
    const mes = formatHidden(item.row, Math.max(0, units.filter(x => x.index > index).length));
    if (typeof mes !== 'string') return unavailable('FLOOR_HIDDEN_FORMATTER_FAILED');
    byIndex.set(index, { row: item.row, index, raw: { ...item.row, is_system: false, mes }, restored: true });
  }
  const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const isOld = unit => isOldIndex(unit.index);
  const old = ordered.filter(isOld);
  const unclassified = legacyPresent ? ordered.filter(x => !isOld(x) && x.index < anchor) : [];
  const current = ordered.filter(x => !isOld(x) && !unclassified.includes(x));
  const render = (unit, region) => {
    if (type === 'continue' && unit.raw === coreChat.at(-1)) return unit.raw;
    return { ...unit.raw, mes: `【${region}】\n${unit.raw.mes}\n【原楼层内容结束】` };
  };
  const ledger = returns.filter(r => r === latestReturn || r.index >= min).map(r => note(
    `【死亡回归记录】死亡时刻=${r.death.event.gameTime}；原时间线=${r.death.event.timelineId}；恢复时刻=${r.event.gameTime}；当前时间线=${r.event.timelineId}；存档=${r.event.archiveKey}；地点=${r.checkpoint.event.location}。这是已经提交的机械恢复，不是当前世界中再次发生的死亡。`));
  const renderedCurrent = new Map(current.map(x => [x.raw, render(x, '当前有效经历')]));
  const currentRows = [...renderedCurrent.values()];
  const pending = latestReturn && !units.some(x => x.index > latestReturn.index && !x.row.is_user);
  if (pending) {
    const cp = latestReturn.checkpoint.event;
    const snapshot = context.chatMetadata?.死亡回归存档?.快照?.[cp.archiveKey];
    if (!snapshot || snapshot.顶层?.时间 !== cp.gameTime || snapshot.顶层?.地点 !== cp.location || snapshot.主角?.生命状态 !== '存活'
      || !['顶层', '主角', '角色', '敌人'].every(k => snapshot[k] && typeof snapshot[k] === 'object')) return unavailable('FLOOR_TARGET_SNAPSHOT_UNAVAILABLE');
    currentRows.push(note(`【恢复目标的完整存档状态】存档=${cp.archiveKey}；时间=${cp.gameTime}；地点=${cp.location}；恢复后时间线=${latestReturn.event.timelineId}。\n${JSON.stringify(snapshot)}`));
  }
  // Preserve the native physical last input, including continue's unwrapped assistant prefill.
  const tail = units.at(-1);
  const tailRow = tail && !isOld(tail) ? renderedCurrent.get(tail.raw) : null;
  if (tailRow) currentRows.splice(currentRows.indexOf(tailRow), 1);
  const rows = [...unclassified.map(x => x.raw), ...old.map(x => render(x, '旧线经历，非当前世界事实')), ...ledger, ...currentRows];
  if (tailRow) rows.push(tailRow);
  return { available: true, code: 'FLOOR_NATIVE_PROJECTED', rows,
    visibleWindow: { first: min, last: max }, restored: ordered.filter(x => x.restored).map(x => x.index),
    old: old.map(x => x.index), current: current.map(x => x.index), unclassified: unclassified.map(x => x.index),
    scopeStart: anchor, returns: ledger.length,
    persisted: false, sourceChatUnchanged: true };
}
