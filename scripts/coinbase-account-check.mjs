// Read-only connection probe. Credentials stay in the supplied local file.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { get } from 'node:https';
import { pathToFileURL } from 'node:url';

// The operator-approved allowlist contains the public IPv4 address only.
// Pin address family rather than weakening that restriction or adding IPv6.
function getCoinbase(url, token) {
 return new Promise((resolve,reject)=>{
  const request=get(url,{family:4,headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)},response=>{
   const chunks=[];let size=0;
   response.on('data',chunk=>{size+=chunk.length;if(size>2097152){response.destroy();reject(Error('Response too large'));}else chunks.push(chunk);});
   response.on('error',reject);
   response.on('end',()=>resolve({ok:response.statusCode===200,status:response.statusCode,
    json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
  });
  request.on('error',reject);
 });
}

export async function readCoinbaseAccounts(credentialPath) {
 const credential=JSON.parse(await readFile(credentialPath,'utf8'));
 if(typeof credential.name!=='string'||typeof credential.privateKey!=='string')throw Error('Invalid credential file');
 const key=createPrivateKey(credential.privateKey);
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('Expected ECDSA P-256 key');
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const accounts=[];let cursor;const seen=new Set();
 for(let page=0;page<20;page++){
  const pathname='/api/v3/brokerage/accounts';
  const now=Math.floor(Date.now()/1000);
  const header=encode({alg:'ES256',typ:'JWT',kid:credential.name,nonce:randomBytes(16).toString('hex')});
  const payload=encode({sub:credential.name,iss:'cdp',nbf:now,exp:now+120,uri:'GET api.coinbase.com'+pathname});
  const unsigned=header+'.'+payload;
  const jwt=unsigned+'.'+sign('sha256',Buffer.from(unsigned),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const url=new URL('https://api.coinbase.com'+pathname);url.searchParams.set('limit','250');
  if(cursor)url.searchParams.set('cursor',cursor);
  const response=await getCoinbase(url,jwt);
  if(!response.ok)throw Error('Coinbase HTTP '+response.status);
  const data=await response.json();
  if(!Array.isArray(data.accounts)||typeof data.has_next!=='boolean')throw Error('Invalid account response');
  for(const a of data.accounts){
   if(!a.currency||!/^\d+(\.\d+)?$/.test(a.available_balance?.value)||!/^\d+(\.\d+)?$/.test(a.hold?.value))throw Error('Invalid balance');
   accounts.push({currency:a.currency,available:a.available_balance.value,held:a.hold.value,active:a.active,ready:a.ready});
  }
  if(!data.has_next){
   const result={observedAt:new Date().toISOString(),authenticated:true,readOnlyProbe:true,executionEnabled:false,accountCount:accounts.length,balances:accounts.filter(a=>/[1-9]/.test(a.available)||/[1-9]/.test(a.held))};
   return result;
  }
  if(typeof data.cursor!=='string'||!data.cursor||seen.has(data.cursor))throw Error('Invalid pagination');
  seen.add(data.cursor);cursor=data.cursor;
 }
 throw Error('Account pagination incomplete');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
try {
 const result=await readCoinbaseAccounts(process.argv[2]);
 await mkdir('artifacts/coinbase-connect-20261011',{recursive:true});
 await writeFile('artifacts/coinbase-connect-20261011/connection.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}catch(error){
 // Do not print provider bodies, tokens, key material or arbitrary parser errors.
 const message=/^Coinbase HTTP \d+$/.test(error.message)?error.message:'Local credential or connection validation failed';
 console.error(message);process.exitCode=1;
}

}
