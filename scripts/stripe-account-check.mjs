import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export async function readStripeTransactions(file,{request=fetch,now=Date.now(),maxPages=10,windowDays=30,signal}={}){
 if(!Number.isSafeInteger(windowDays)||windowDays<1||windowDays>732)throw Error('Invalid window');
 if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>10)throw Error('Invalid page limit');
 await readStripeAccount(file,request,signal); // Account identity and live mode must agree first.
 const {secretKey}=JSON.parse(await readFile(file,'utf8')),to=Math.floor(now/1000),from=Math.max(0,to-windowDays*86400),transactions=[];
 let cursor,complete=false;const cursors=new Set();
 for(let page=0;page<maxPages;page++){
  if(signal?.aborted)throw Error('Stopped');
  const query=new URLSearchParams({limit:'100','created[gte]':String(from),'created[lte]':String(to)});if(cursor)query.set('starting_after',cursor);
  const response=await request('https://api.stripe.com/v1/balance_transactions?'+query,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+secretKey},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  if(!response.ok||!response.body)throw Error('Stripe transaction read unavailable');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1048576)throw Error('Response limit');chunks.push(part.value);}}finally{await reader.cancel();}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(data.object!=='list'||!Array.isArray(data.data)||data.data.length>100||typeof data.has_more!=='boolean')throw Error('Invalid page');
  for(const row of data.data){if(row.created<from||row.created>to)throw Error('Outside coverage');transactions.push(Object.fromEntries(['id','type','amount','fee','net','currency','created'].map(k=>[k,row[k]])));}
  if(!data.has_more){complete=true;break;}
  cursor=data.data.at(-1)?.id;if(!/^txn_[\w]+$/.test(cursor??'')||cursors.has(cursor))throw Error('Invalid cursor');cursors.add(cursor);
 }
 return {transactions,coverage:{complete,from,to,source:'Stripe balance transactions',windowDays}};
}

export async function readStripeAccount(file, request=fetch, signal) {
 const {secretKey,accountId}=JSON.parse(await readFile(file,'utf8'));
 if(!/^rk_live_[A-Za-z0-9]+$/.test(secretKey??'')||!/^acct_[A-Za-z0-9]+$/.test(accountId??''))throw Error('Invalid Stripe credential');
 async function get(path){
  try {
   if(signal?.aborted)throw Error('Stopped');
   const r=await request('https://api.stripe.com/v1/'+path,{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+secretKey}});
   if(!r.ok||!r.body)throw Error('Unavailable');
   const reader=r.body.getReader(),chunks=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1048576)throw Error('Oversized');chunks.push(part.value);}}finally{await reader.cancel();}
   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw Error('Stripe read unavailable');}
 }
 const account=await get('account');
 if(account.id!==accountId||account.object!=='account')throw Error('Stripe account mismatch');
 const balance=await get('balance');
 if(balance.object!=='balance'||balance.livemode!==true)throw Error('Stripe mode mismatch');
 function amounts(rows){
  if(!Array.isArray(rows)||rows.length>200)throw Error('Invalid balances');
  return rows.map(x=>{if(!/^[a-z]{3}$/.test(x.currency)||!Number.isSafeInteger(x.amount))throw Error('Invalid balance');return {currency:x.currency,amountMinor:x.amount};});
 }
 return {observedAt:new Date().toISOString(),authenticated:true,readOnlyProbe:true,executionEnabled:false,
  chargesEnabled:account.charges_enabled===true,payoutsEnabled:account.payouts_enabled===true,
  available:amounts(balance.available),pending:amounts(balance.pending),
  requirements:{disabledReason:account.requirements?.disabled_reason??null,
   currentlyDue:Array.isArray(account.requirements?.currently_due)?account.requirements.currently_due:[],
   pendingVerification:Array.isArray(account.requirements?.pending_verification)?account.requirements.pending_verification:[]},
  limitation:'Stripe balances are not verified bank receipts or net profit.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const result=await readStripeAccount(process.argv[2]);if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
 catch{console.error('Stripe connection check failed; no credentials or provider payload logged.');process.exitCode=1;}
}
