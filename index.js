import { isGenerating, setSendButtonState } from '../../../../script.js';
import { readFloorMark } from './floor-marks.mjs';
import { getRegexedString, regex_placement } from '../../regex/engine.js';
import { projectNativeFloors } from './native-floor-projector.mjs';

const functionKey = 'huoxiaquNativeFloorInterceptor';
const seen = new WeakSet();
let installed = false;
let lastStatus = { available: false, code: 'FLOOR_NOT_RUN' };

function contextStillSame(ctx, chatId, chat, metadata, sources) {
  const now = globalThis.SillyTavern?.getContext?.();
  return now?.getCurrentChatId?.() === chatId && now.chat === chat && now.chatMetadata === metadata
    && now.chat.length === sources.length
    && sources.every((source, i) => now.chat[i] === source.row && source.row.mes === source.text
      && (source.row.swipe_id ?? 0) === source.page && source.row.extra === source.extra);
}

export function huoxiaquNativeFloorInterceptor(coreChat, contextSize, abort, type) {
  if (!installed || !Array.isArray(coreChat) || seen.has(coreChat)) return;
  seen.add(coreChat);
  const ctx = globalThis.SillyTavern?.getContext?.();
  if (!Array.isArray(ctx?.chat)) return;
  const chatId = ctx.getCurrentChatId?.(), chat = ctx.chat, metadata = ctx.chatMetadata;
  const sources = chat.map(row => ({ row, text: row.mes, page: row.swipe_id ?? 0, extra: row.extra }));
  try {
    const result = projectNativeFloors(coreChat, ctx, { type,
      formatHidden: (row, depth) => getRegexedString(row.mes,
        row.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT,
        { isPrompt: true, depth }) });
    if (!contextStillSame(ctx, chatId, chat, metadata, sources)) {
      lastStatus = { available: false, code: 'FLOOR_CONTEXT_CHANGED' };
      return;
    }
    lastStatus = { available: result.available, code: result.code };
    if (result.available) coreChat.splice(0, coreChat.length, ...result.rows);
  } catch (error) {
    lastStatus = { available: false, code: 'FLOOR_PROJECTION_ERROR' };
    console.warn('[活下去]', String(error?.message ?? error));
  }
}

export async function prepareNativeRecompute(type, detail = {}) {
  const ctx = globalThis.SillyTavern?.getContext?.();
  const special = ctx?.chatMetadata?.死亡回归事务?.entries?.length
    || ['regenerate', 'delete'].includes(type) && ctx?.chat?.some(row => row?.extra?.回归存档点 === true);
  if (!special) return { ok: true, code: 'RETURN_UNDO_NOT_NEEDED' };
  const book = globalThis.document?.documentElement?.__DSH热重载;
  const record = book?.桥?.准备原生回归重算;
  const owner = record && [...(book?.[record.键 + '__候选'] ?? [])].reverse().find(x => x && !x.已销毁);
  if (!record || owner?.令牌 !== record.令牌 || typeof record.值 !== 'function') return { ok: false, code: 'RETURN_UNDO_PROVIDER_MISSING' };
  return await record.值({ ...detail, type, chat: ctx.chat, metadata: ctx.chatMetadata, id: ctx.getCurrentChatId?.() });
}

const transactionSendOwnerKey = Symbol.for('huoxiaqu.native-transaction.send-owner');
let transactionSendOwner = null;
function releaseTransactionSendOwner(owner) {
  if (!owner || owner.handed || transactionSendOwner !== owner) return;
  transactionSendOwner = null;
  if (globalThis[transactionSendOwnerKey] !== owner) return;
  delete globalThis[transactionSendOwnerKey];
  const now = globalThis.SillyTavern?.getContext?.();
  if (transactionGenerationEpoch === owner.epoch && now?.chat === owner.chat && now.chatMetadata === owner.metadata
      && now.getCurrentChatId?.() === owner.id) setSendButtonState(false);
}
function handoffTransactionSendOwner(owner) {
  if (!owner || transactionSendOwner !== owner || globalThis[transactionSendOwnerKey] !== owner) throw Error('RETURN_UNDO_SEND_OWNER_CHANGED');
  owner.handed = true;
  transactionSendOwner = null;
  delete globalThis[transactionSendOwnerKey];
}

let transactionClickBusy = false;
let transactionGenerationEpoch = 0;
let transactionEventBus = null;
const nativeGenerationObserved = () => { transactionGenerationEpoch++; };
function transactionCardContext(ctx) {
  return !!ctx?.chatMetadata?.死亡回归存档 && Array.isArray(ctx.chat);
}
function transactionAffected(ctx, kind) {
  if (!transactionCardContext(ctx)) return false;
  const entries = ctx.chatMetadata.死亡回归事务?.entries;
  const last = Array.isArray(entries) ? entries.at(-1) : null;
  if (kind === 'regenerate') {
    const tail = ctx.chat.at(-1), mark = readFloorMark(tail);
    return tail?.extra?.回归存档点 === true || !!last && mark?.uid === last.source.uid;
  }
  const selected = [...document.querySelectorAll('#chat .mes.selected[mesid]')].map(node => Number(node.getAttribute('mesid')));
  const start = selected.length ? Math.min(...selected) : -1;
  return start >= 0 && (ctx.chat.slice(start).some(row => row?.extra?.回归存档点 === true || readFloorMark(row)) || !!last && start <= last.sourceIndex);
}
export async function onNativeTransactionClick(event) {
  if (!installed || event.isTrusted !== true) return;
  const control = event.target?.closest?.('#option_regenerate, #dialogue_del_mes_ok');
  if (!control) return;
  const kind = control.id === 'option_regenerate' ? 'regenerate' : 'delete';
  const ctx = globalThis.SillyTavern?.getContext?.();
  if (!transactionAffected(ctx, kind)) return;
  // Stop the original native click synchronously, before any awaited work.
  event.preventDefault(); event.stopImmediatePropagation();
  if (transactionClickBusy || isGenerating()) return;
  if (ctx.groupId != null || document.querySelector('#chat .mes .edit_textarea')) {
    console.warn('[活下去] 原生回归操作未开始：RETURN_UNDO_GROUP_OR_EDITOR_UNSUPPORTED'); return;
  }
  const chat = ctx.chat, metadata = ctx.chatMetadata, id = ctx.getCurrentChatId?.(), epoch = transactionGenerationEpoch;
  const same = () => { const now = globalThis.SillyTavern?.getContext?.(); return installed && now?.chat === chat && now.chatMetadata === metadata && now.getCurrentChatId?.() === id && transactionGenerationEpoch === epoch; };
  const selected = kind === 'delete' ? [...document.querySelectorAll('#chat .mes.selected[mesid]')].map(node => Number(node.getAttribute('mesid'))) : [];
  const deleteFrom = selected.length ? Math.min(...selected) : null;
  const sendOwner = { token: Symbol(), chat, metadata, id, epoch, handed: false };
  transactionSendOwner = sendOwner; globalThis[transactionSendOwnerKey] = sendOwner;
  transactionClickBusy = true; setSendButtonState(true);
  try {
    const receipt = await prepareNativeRecompute(kind, { deleteFrom });
    if (!receipt?.ok) throw Error(receipt?.code ?? 'RETURN_UNDO_UNCONFIRMED');
    if (!same()) throw Error('RETURN_UNDO_UI_SOURCE_CHANGED');
    if (kind === 'delete') {
      // The proven source range was already undone, saved/read back, then deleted natively.
      document.getElementById('dialogue_del_mes_cancel')?.click();
      return;
    }
    if (typeof ctx.generate !== 'function') throw Error('RETURN_UNDO_NATIVE_GENERATE_MISSING');
    // This trusted DOM click has no jQuery customData. Native buildOrFillAdditionalArgs() is exactly {}.
    handoffTransactionSendOwner(sendOwner);
    await ctx.generate('regenerate', {});
  } catch (error) {
    console.warn('[活下去] 原生回归操作已停止：' + String(error?.message ?? error));
    try { globalThis.toastr?.warning('这次回归记录暂时无法安全重算，操作已停止。'); } catch {}
  } finally {
    releaseTransactionSendOwner(sendOwner);
    transactionClickBusy = false;
  }
}
function installTransactionClick() {
  document.addEventListener('click', onNativeTransactionClick, true);
  const ctx = globalThis.SillyTavern?.getContext?.();
  if (ctx?.eventSource && ctx?.eventTypes?.GENERATION_STARTED) {
    transactionEventBus = { bus: ctx.eventSource, name: ctx.eventTypes.GENERATION_STARTED };
    transactionEventBus.bus.on(transactionEventBus.name, nativeGenerationObserved);
  }
}
function disposeTransactionClick() {
  releaseTransactionSendOwner(transactionSendOwner);
  document.removeEventListener('click', onNativeTransactionClick, true);
  if (transactionEventBus) transactionEventBus.bus.removeListener(transactionEventBus.name, nativeGenerationObserved);
  transactionEventBus = null;
}

export function readStatus() { return { ...lastStatus }; }
export function activate() {
  const existing = globalThis[functionKey];
  if (existing && existing !== huoxiaquNativeFloorInterceptor) throw Error('FLOOR_INTERCEPTOR_ALREADY_REGISTERED');
  globalThis[functionKey] = huoxiaquNativeFloorInterceptor;
  installTransactionClick();
  installed = true;
}
export function dispose() {
  installed = false;
  disposeTransactionClick();
  if (globalThis[functionKey] === huoxiaquNativeFloorInterceptor) delete globalThis[functionKey];
}
activate();
globalThis.addEventListener?.('pagehide', dispose, { once: true });
