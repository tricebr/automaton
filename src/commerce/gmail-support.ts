import {isUtf8} from 'node:buffer';
import type {Database} from 'better-sqlite3';
import {receiveSupportMessage} from './support-inbox.js';
import {supportIntakeScope} from './support-poll.js';
import {assertActionGate,securityTransaction} from '../security/action-gate.js';
import {bindSupportReceipt,SupportDeliveryNotStartedError,verifySupportSendAuthorization,type SupportSendAuthorization,type SupportReply,type SupportTransport} from './support-outbox.js';

const API='https://gmail.googleapis.com/gmail/v1/users/me';
const ref=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(s);
const address=(s:unknown):s is string=>typeof s==='string'&&s.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s);
const encodedSubject=(subject:string)=>{
  const words:string[]=[];let chunk='';
  for(const character of subject){if(Buffer.byteLength(chunk+character)>30){words.push(chunk);chunk='';}chunk+=character;}
  if(chunk)words.push(chunk);
  return words.map(word=>`=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
};

/** OAuth token supplier belongs to operator setup. Tokens are never stored, logged or returned.
 * Gmail receipt authenticates the mailbox source, not the external sender's legal identity.
 */
export class GmailSupportClient implements SupportTransport {
  private readonly mailbox:string;
  constructor(mailbox:string,private readonly supportLabel:string,private readonly token:()=>Promise<string>,private readonly request:typeof fetch=fetch){
    if(!address(mailbox)||!/^Label_[A-Za-z0-9_-]{1,100}$/.test(supportLabel))throw new Error('Explicit Gmail mailbox and custom support label required');
    this.mailbox=mailbox.toLowerCase();
  }
  private async json(url:string,token:string,body?:object):Promise<any>{
    try{
      const response=await this.request(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok||!response.body)throw new Error('request failed');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>262144)throw new Error('response too large');chunks.push(part.value);}}
      finally{await reader.cancel();}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw new Error('Gmail request unavailable or invalid; provider reconciliation may be required');}
  }
  private async credentials(){
    let token:string;
    try{token=await this.token();}catch{throw new Error('Gmail credentials unavailable');}
    if(typeof token!=='string'||!token.length||token.length>16384||/\s/.test(token))throw new Error('Gmail credentials unavailable');
    const profile=await this.json(`${API}/profile`,token);
    if(typeof profile?.emailAddress!=='string'||profile.emailAddress.toLowerCase()!==this.mailbox)throw new Error('Gmail account mismatch');
    return token;
  }
  get intakeScope(){return {mailbox:this.mailbox,label:this.supportLabel};}
  async listIncoming(pageToken:string|null){
    // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
    if(pageToken!==null&&(typeof pageToken!=='string'||pageToken.length>2048||/[\u0000-\u0020]/u.test(pageToken)))throw new Error('Invalid Gmail page cursor');
    const token=await this.credentials();
    const query=new URLSearchParams({labelIds:this.supportLabel,maxResults:'10',includeSpamTrash:'false',q:'-in:sent -in:drafts'});
    if(pageToken)query.set('pageToken',pageToken);
    const result=await this.json(`${API}/messages?${query}`,token);
    const messages=result?.messages??[];
    if(!Array.isArray(messages)||messages.length>10||messages.some((item:any)=>!ref(item?.id)))throw new Error('Invalid bounded Gmail message list');
    const next=result?.nextPageToken??null;
    // oxlint-disable-next-line no-control-regex -- Intentionally reject or sanitize control characters at the security boundary.
    if(next!==null&&(typeof next!=='string'||!next.length||next.length>2048||/[\u0000-\u0020]/u.test(next)))throw new Error('Invalid Gmail continuation');
    return {ids:[...new Set<string>(messages.map((item:any)=>item.id))],nextPageToken:next};
  }
  async receive(db:Database,providerId:string){
    if(!ref(providerId))throw new Error('Invalid Gmail message ID');
    assertActionGate(db,supportIntakeScope(this.mailbox,this.supportLabel));
    const token=await this.credentials(),message=await this.json(`${API}/messages/${encodeURIComponent(providerId)}?format=full`,token);
    if(message?.id!==providerId||!ref(message.threadId)||!Array.isArray(message.labelIds)||!message.labelIds.includes(this.supportLabel)||
      message.labelIds.some((label:string)=>['SENT','DRAFT','SPAM','TRASH'].includes(label)))throw new Error('Message is not in the authorized support intake');
    const headers=message.payload?.headers;
    if(!Array.isArray(headers)||headers.length>100)throw new Error('Invalid support headers');
    const header=(name:string,required=false)=>{
      const found=headers.filter((h:any)=>typeof h?.name==='string'&&h.name.toLowerCase()===name);
      if(found.length>1||required&&found.length!==1||found.some((h:any)=>typeof h.value!=='string'||h.value.length>1000||/[\r\n\0]/.test(h.value)))throw new Error('Ambiguous support headers');
      return found[0]?.value??'';
    };
    const from=header('from',true),sender=from.match(/^[^<>\r\n,]*<([^<>]+)>$/)?.[1]??from;
    const replyTo=header('reply-to'),subject=header('subject'),messageId=header('message-id',true);
    if(!address(sender)||sender.toLowerCase()===this.mailbox||replyTo&&replyTo.toLowerCase()!==sender.toLowerCase()||
      header('auto-submitted')&&!/^no$/i.test(header('auto-submitted'))||header('list-id')||/^(bulk|list|junk)$/i.test(header('precedence'))||subject.includes('=?'))
      throw new Error('Automated, redirected or unsupported support message requires review');
    const texts:string[]=[];let parts=0,bytes=0;
    const visit=(part:any)=>{
      if(++parts>30)throw new Error('Support message part limit exceeded');
      if(part?.mimeType==='text/plain'&&!part.filename&&typeof part.body?.data==='string'){
        if(!/^[A-Za-z0-9_-]*={0,2}$/.test(part.body.data))throw new Error('Invalid support text encoding');
        const decoded=Buffer.from(part.body.data,'base64url');bytes+=decoded.length;
        if(bytes>64000||!isUtf8(decoded))throw new Error('Support text limit or encoding invalid');
        texts.push(decoded.toString('utf8'));
      }
      if(Array.isArray(part?.parts))for(const child of part.parts)visit(child);
    };visit(message.payload);
    if(!texts.length)throw new Error('Plain-text support message required; no automatic attachment or HTML processing');
    return securityTransaction(db,()=>{
      assertActionGate(db,supportIntakeScope(this.mailbox,this.supportLabel));
      const received=receiveSupportMessage(db,{mailbox:this.mailbox,providerId,from:sender.toLowerCase(),subject,body:texts.join('\n')});
      bindSupportReceipt(db,received.id,{mailbox:this.mailbox,sender:sender.toLowerCase(),messageId,threadId:message.threadId});
      return {id:received.id,duplicate:received.duplicate};
    }).immediate();
  }
  private async prepareSend(reply:SupportReply){
    if(reply.mailbox!==this.mailbox||!address(reply.recipient)||!ref(reply.threadId)||!ref(reply.id)||typeof reply.subject!=='string'||/[\r\n\0]/.test(reply.subject)||
      Buffer.byteLength(reply.subject)>300||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(reply.inReplyTo)||reply.inReplyTo.length>200||
      typeof reply.body!=='string'||!reply.body.trim()||reply.body.includes('\0')||Buffer.byteLength(reply.body)>20000)throw new Error('Invalid bound support reply');
    const token=await this.credentials();
    // Encoded words and base64 body prevent message text from adding transport headers.
    const subject=encodedSubject(reply.subject);
    const body=Buffer.from(reply.body).toString('base64').match(/.{1,76}/g)!.join('\r\n');
    const raw=[`From: ${this.mailbox}`,`To: ${reply.recipient}`,`Subject: ${subject}`,`In-Reply-To: ${reply.inReplyTo}`,`References: ${reply.inReplyTo}`,
      `Message-ID: <obolus-${reply.id}@${this.mailbox.split('@')[1]}>`,`Date: ${new Date().toUTCString()}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body].join('\r\n');
    return {token,raw:Buffer.from(raw).toString('base64url')};
  }
  async send(reply:SupportReply,authorization?:SupportSendAuthorization){
    verifySupportSendAuthorization(reply,authorization);
    let prepared:{token:string;raw:string};
    try{prepared=await this.prepareSend(reply);}catch{throw new SupportDeliveryNotStartedError();}
    verifySupportSendAuthorization(reply,authorization,true);
    const result=await this.json(`${API}/messages/send`,prepared.token,{raw:prepared.raw,threadId:reply.threadId});
    if(!ref(result?.id)||result.threadId!==reply.threadId)throw new Error('Gmail send confirmation mismatch; reconcile before retry');
    return {providerId:result.id};
  }
  async confirm(reply:SupportReply,providerId:string){
    if(!ref(providerId)||reply.mailbox!==this.mailbox)throw new Error('Invalid support confirmation scope');
    const token=await this.credentials(),message=await this.json(`${API}/messages/${encodeURIComponent(providerId)}?format=full`,token);
    if(message?.id!==providerId||message.threadId!==reply.threadId||!Array.isArray(message.labelIds)||!message.labelIds.includes('SENT'))throw new Error('Sent message confirmation mismatch');
    const headers=message.payload?.headers;
    if(!Array.isArray(headers)||headers.length>100)throw new Error('Invalid confirmation headers');
    const one=(name:string)=>{const values=headers.filter((h:any)=>typeof h?.name==='string'&&h.name.toLowerCase()===name);return values.length===1?values[0].value:undefined;};
    if(headers.some((h:any)=>typeof h?.name==='string'&&['cc','bcc'].includes(h.name.toLowerCase())))throw new Error('Unexpected additional reply recipients');
    const subject=one('subject');
    if(typeof subject!=='string'||subject.length>2000||
      subject!==reply.subject&&subject.replace(/\r\n[ \t]+/g,' ')!==encodedSubject(reply.subject).replace(/\r\n[ \t]+/g,' '))
      throw new Error('Sent message subject mismatch');
    if(one('message-id')!==`<obolus-${reply.id}@${this.mailbox.split('@')[1]}>`||one('to')!==reply.recipient||one('from')!==this.mailbox||
      one('in-reply-to')!==reply.inReplyTo||message.payload?.mimeType!=='text/plain'||message.payload.filename||
      message.payload.parts!==undefined&&(!Array.isArray(message.payload.parts)||message.payload.parts.length>0)||
      typeof message.payload?.body?.data!=='string'||message.payload.body.data.length>30000||!/^[A-Za-z0-9_-]*={0,2}$/.test(message.payload.body.data))
      throw new Error('Sent message binding mismatch');
    const decoded=Buffer.from(message.payload.body.data,'base64url');
    if(decoded.toString('base64url')!==message.payload.body.data.replace(/=+$/,'')||!isUtf8(decoded)||decoded.toString('utf8')!==reply.body)throw new Error('Sent message content mismatch');
  }
}
