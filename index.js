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

export function readStatus() { return { ...lastStatus }; }
export function activate() {
  const existing = globalThis[functionKey];
  if (existing && existing !== huoxiaquNativeFloorInterceptor) throw Error('FLOOR_INTERCEPTOR_ALREADY_REGISTERED');
  globalThis[functionKey] = huoxiaquNativeFloorInterceptor;
  installed = true;
}
export function dispose() {
  installed = false;
  if (globalThis[functionKey] === huoxiaquNativeFloorInterceptor) delete globalThis[functionKey];
}
activate();
globalThis.addEventListener?.('pagehide', dispose, { once: true });
