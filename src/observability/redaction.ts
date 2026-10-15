const secrets = new Set<string>();
const sensitiveKey = /api[_-]?key|private[_-]?key|secret|password|passphrase|authorization|cookie|access[_-]?token|refresh[_-]?token|mnemonic/i;
function secretRepresentations(value:string):string[] {
  return [value, JSON.stringify(value).slice(1,-1), encodeURIComponent(value),
    Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')];
}
export function registerLogSecrets(values: unknown[]): void {
  for (const value of values) if (typeof value === "string" && value.length >= 8 && value.length <= 16384) {
    if (secrets.size >= 256 && !secrets.has(value)) throw new Error("Secret redaction registry capacity exceeded");
    secrets.add(value);
  }
}
export function registerConfigurationSecrets(config: Record<string,unknown>): void {
  const pending: Array<{value:unknown;sensitive:boolean}> = [{value:config,sensitive:false}];
  const seen = new Map<object,boolean>();
  let visited = 0;
  while(pending.length){
    if(++visited>10000)throw new Error("Configuration secret traversal limit exceeded");
    const {value,sensitive}=pending.pop()!;
    if(typeof value==='string'){if(sensitive)registerLogSecrets([value]);continue;}
    if(!value||typeof value!=='object')continue;
    const previous=seen.get(value);
    if(previous===true||previous===false&&!sensitive)continue;
    seen.set(value,sensitive);
    for(const [key,item] of Object.entries(value))pending.push({value:item,sensitive:sensitive||sensitiveKey.test(key)});
  }
}
/** Memory must reject, not silently rewrite, known credential material. This
 * cannot recognize arbitrary previously unknown secret formats or encodings. */
export function assertNoKnownSecrets(value:unknown):void {
  const text=JSON.stringify(value);
  if(typeof text!=="string")throw new Error("Invalid memory content");
  const known=[...secrets,...Object.entries(process.env).filter(([key])=>sensitiveKey.test(key)).map(([,item])=>item)
    .filter((item):item is string=>typeof item==='string'&&item.length>=8)];
  if(known.some(secret=>secretRepresentations(secret).some(form=>text.includes(form))) ||
    /\b(?:sk|rk|whsec)[_-][A-Za-z0-9_-]{16,}\b|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
    throw new Error("Credential material is not allowed in economic memory");
  }
}
export function redactLogText(text:string):string {
  let result=text;
  for(const [name,value] of Object.entries(process.env))if(sensitiveKey.test(name)&&value&&value.length>=8)
    for(const form of secretRepresentations(value))result=result.split(form).join("[REDACTED]");
  for(const value of secrets)for(const form of secretRepresentations(value))result=result.split(form).join("[REDACTED]");
  return result
    .replace(/-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,"[REDACTED-PRIVATE-KEY]")
    .replace(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,"[REDACTED-EMAIL]")
    .replace(/\b(?:sk|rk|whsec)[_-][A-Za-z0-9_-]{12,}\b/g,"[REDACTED]")
    .replace(/\b0x[a-fA-F0-9]{64}\b/g,"[REDACTED-KEY-OR-HASH]")
    .replace(/(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi,"$1[REDACTED]")
    .replace(/((?:api[_-]?key|private[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,"$1[REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/g,value=>{
      try{const url=new URL(value);if(url.username||url.password){url.username="REDACTED";url.password="";}if(url.search)url.search="?REDACTED";return url.toString();}catch{return "[REDACTED-URL]";}
    });
}
export function redactLogValue(value:unknown,depth=0,seen=new Set<object>()):unknown {
  if(typeof value==="string")return redactLogText(value);
  if(value===null||typeof value!=="object")return value;
  if(depth>=8)return "[DEPTH-LIMIT]";
  if(seen.has(value))return "[CIRCULAR]";
  seen.add(value);
  const result:Array<unknown>|Record<string,unknown>=Array.isArray(value)?[]:Object.create(null);
  for(const [key,item] of Object.entries(value).slice(0,100)) {
    const clean=sensitiveKey.test(key)?"[REDACTED]":redactLogValue(item,depth+1,seen);
    if(Array.isArray(result))result.push(clean);else result[key]=clean;
  }
  seen.delete(value);
  return result;
}
