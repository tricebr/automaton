import {assertNoKnownSecrets} from '../observability/redaction.js';

/** High-confidence signals, not a universal PII classifier. Never returns raw
 * matches. Dedicated support transports have separate reviewed recipient and
 * purpose controls; ordinary model context does not inherit that authority. */
export function assertModelPrivacy(value:unknown,local=false){
 assertNoKnownSecrets(value);
 // Inspect a canonical view as well, without changing the original payload.
 // Fullwidth characters or invisible format controls must not bypass DLP.
 const text=JSON.stringify(value).normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g,'');
 assertNoKnownSecrets(text);
 if(local)return;
 if(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text)||
   /\b\d{3}-\d{2}-\d{4}\b/.test(text)||
   /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/.test(text))
  throw Error('Personal or payment data blocked from ordinary external model context; minimize data or use an authorized isolated local path');
}
