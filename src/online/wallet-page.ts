import { readBaseBalance } from "./wallet-balance.js";
/** Browser account access only: no signing, payments or capital credits. */
export function walletPage(nonce: string): string {
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Obolus · MetaMask</title>
<style nonce="${nonce}">body{background:#111923;color:#e4eaf1;font:17px system-ui;max-width:760px;margin:60px auto;padding:24px}h1{color:#e8c782}button{padding:14px;margin:8px;font:inherit;cursor:pointer}p{line-height:1.6;overflow-wrap:anywhere}</style>
<h1>Obolus · MetaMask verbinden</h1><p>Öffne diese Seite im Browser mit MetaMask. Nur die öffentliche Adresse wird freigegeben. Keine Signatur, Zahlung oder Handelsberechtigung wird angefordert.</p>
<p>Erwartetes Konto: 0x6Cc15B882a463423ea7A400Ce6512c30b1A76615 · Base Mainnet</p>
<button id="connect">Mit MetaMask verbinden</button><button id="base" disabled>Auf Base wechseln</button><p id="state" role="status">Noch nicht verbunden.</p>
<button id="balance" disabled>Bestand lesen</button><p id="balances" role="status">Bestand unbekannt. Keine Kapitalgutschrift.</p>
<p>Die Verbindung gilt für diese lokale Browserseite. Kein autonomer Agent wird gestartet. Berechtigungen kannst du in MetaMask unter den verbundenen Websites widerrufen.</p>
<script nonce="${nonce}">
const expected='0x6cc15b882a463423ea7a400ce6512c30b1a76615';
const state=document.getElementById('state'),connect=document.getElementById('connect'),base=document.getElementById('base');
const balance=document.getElementById('balance'),balances=document.getElementById('balances');
const readBalance=${readBaseBalance.toString()};
let provider,version=0,bound=false;
window.addEventListener('eip6963:announceProvider',event=>{if(event.detail?.info?.rdns==='io.metamask'&&!provider)provider=event.detail.provider;});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function invalidate(){version++;base.disabled=true;balance.disabled=true;balances.textContent='Bestand unbekannt. Bitte erneut prüfen.';state.textContent='Konto oder Netzwerk geändert. Bitte erneut verbinden und prüfen.';}
async function check(){const stamp=++version;const accounts=await provider.request({method:'eth_accounts'});const chain=await provider.request({method:'eth_chainId'});if(stamp!==version)return;const match=Array.isArray(accounts)&&typeof accounts[0]==='string'&&accounts[0].toLowerCase()===expected;balance.disabled=!match||chain!=='0x2105';base.disabled=!match||chain==='0x2105';state.textContent=!match?'Nicht mit dem erwarteten Konto verbunden. Bitte in MetaMask Konto 0x6Cc1…76615 auswählen.':chain!=='0x2105'?'Konto freigegeben. Bitte auf Base wechseln.':'Verbunden: bestätigte Adresse auf Base. Keine Ausgabenberechtigung.';}
function failure(e){version++;balance.disabled=true;balances.textContent='Bestand unbekannt.';base.disabled=true;state.textContent=e?.code===4001?'Anfrage abgelehnt. Verbindung nicht bestätigt.':e?.code===-32002?'Eine Anfrage wartet in MetaMask. Bitte dort prüfen.':'Verbindung nicht bestätigt. MetaMask öffnen und Konto sowie Netzwerk prüfen.';}
connect.onclick=async()=>{balance.disabled=true;balances.textContent='Bestand unbekannt.';connect.disabled=true;base.disabled=true;state.textContent='Bitte Anfrage in MetaMask prüfen …';try{provider=provider||(window.ethereum?.isMetaMask?window.ethereum:undefined);if(!provider){state.textContent='MetaMask nicht gefunden. Diese URL in Chrome oder Edge mit MetaMask öffnen.';return;}if(!bound){provider.on?.('accountsChanged',invalidate);provider.on?.('chainChanged',invalidate);provider.on?.('disconnect',invalidate);bound=true;}await provider.request({method:'eth_requestAccounts'});await check();}catch(e){failure(e);}finally{connect.disabled=false;}};
base.onclick=async()=>{base.disabled=true;connect.disabled=true;try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});await check();}catch(e){failure(e);if(e?.code===4902)state.textContent='Bitte Base in MetaMask hinzufügen und erneut verbinden.';}finally{connect.disabled=false;}};
balance.onclick=async()=>{const stamp=version;balance.disabled=true;balances.textContent='Finalisierten Bestand lesen …';try{const result=await readBalance(provider,expected);if(stamp!==version)return;balances.textContent=result.eth+' ETH · '+result.usdc+' USDC · finalisierter Block '+result.blockNumber+' · Zeitpunkt '+new Date().toLocaleString()+' · RPC-Auskunft, kein Umsatznachweis und keine Kapitalgutschrift.';}catch{if(stamp===version)balances.textContent='Bestand konnte nicht bestätigt werden. Kein Nullbestand angenommen.';}finally{if(stamp===version)balance.disabled=false;}};
</script></html>`;
}
