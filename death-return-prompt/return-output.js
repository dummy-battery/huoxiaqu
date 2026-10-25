// Narrow output branch used by native saveReply.
// Dependency callbacks are native storage/render/metadata functions; no normal fallback.
export async function saveReturnContinueReply(output,args,native) {
    output.check();
    if(args.type!=='continue'||native.group)throw Error('RETURN_CONTINUE_NATIVE_SCOPE_UNSUPPORTED');
    const text=native.trim?String(args.getMessage??'').trim():String(args.getMessage??'');
    if(!args.fromStreaming&&(!text.trim()||text==='...'))throw Error('RETURN_CONTINUE_EMPTY_BODY');
    if(native.chat.length!==output.index)throw Error('RETURN_CONTINUE_DUPLICATE_CREATE');
    const message={name:native.name,is_user:false,is_system:false,mes:text,title:args.title,
        send_date:native.timestamp(),gen_started:native.started,gen_finished:native.now(),swipe_id:0,swipes:[text],
        extra:{api:native.api(),model:native.model(),reasoning:args.reasoning??'',reasoning_duration:null,reasoning_signature:args.reasoningSignature??null}};
    if(native.tokenCount){message.extra.token_count=await native.tokenCount((args.reasoning??'')+text,0);output.check();}
    const attachmentStage=output.stageAttachment(native.name);
    output.checkAttachmentStage(attachmentStage);
    await native.image(attachmentStage,{imageUrls:args.imageUrls??[]});
    output.checkAttachmentStage(attachmentStage);
    const stagedExtra=structuredClone(attachmentStage.extra);
    output.checkAttachmentStage(attachmentStage);
    Object.assign(message.extra,stagedExtra);
    output.check();
    // Creation happens only after detached attachment preparation and belongs to the reserved UID.
    const messageId=output.create(message);
    message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,gen_finished:message.gen_finished,extra:structuredClone(message.extra)}];
    output.assert(messageId);native.stats(message);
    if(!args.fromStreaming)output.seal();
    native.render(message);output.assert(messageId);
    if(!args.fromStreaming){
        await native.received(messageId);
        // Owner may already have published its confirmed ledger in the event tail.
        await output.complete();
        await native.rendered(messageId);
    }
    return {type:'continue',getMessage:text,messageId,uid:output.uid};
}
