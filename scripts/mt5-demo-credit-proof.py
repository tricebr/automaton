"""Narrow, local receipt for a verified broker mail; never a deal clock correction.

The receipt is prepared from the authenticated Gmail connector's broker message
and contains no passwords/body. Only one unchanged, positive demo-opening credit
in complete lifetime history can be anchored to this pre-day balance.
"""
import json,math,re
from datetime import datetime
from pathlib import Path

RECEIPT_FILE=Path(__file__).resolve().parent.parent/'artifacts/founder-integration-20261012/demo-opening-balance-proof.json'
def load_receipt():
    try:
        if RECEIPT_FILE.is_symlink() or not RECEIPT_FILE.is_file() or RECEIPT_FILE.stat().st_size>16000:return None
        return json.loads(RECEIPT_FILE.read_text(encoding='utf-8'))
    except (OSError,ValueError):return None

def verify_demo_opening_credit(receipt,account,deals,window,now_ms,*,positions,orders):
    try:
        r=receipt;a=account
        if not isinstance(r,dict) or r.get('schemaVersion')!=1 or r.get('kind')!='admirals-demo-opening-balance':return None
        if r.get('sender')!='global@admiralmarkets.com' or not re.fullmatch('[a-f0-9]{16}',r.get('messageId','')):return None
        if not all(r.get(k) is True for k in ['dkimPass','dmarcPass','accountConfirmed','serverConfirmed','newDemoAccountConfirmed','balanceConfirmed']):return None
        received=datetime.fromisoformat(r['receivedAt']);issued=datetime.fromisoformat(r['brokerDate'])
        if received.tzinfo is None or issued.tzinfo is None:return None
        received_ms=received.timestamp()*1000
        if abs((received-issued).total_seconds())>60 or not 0<received_ms<window['startsAt']<=now_ms<window['endsAt'] or now_ms-received_ms>30*86400000:return None
        if a.trade_mode!=0 or a.server!='AdmiralsGroup-Demo' or str(a.login)!=r['account'] or a.server!=r['server'] or a.currency!=r['currency']:return None
        amount=r['balance']
        if isinstance(amount,bool) or not isinstance(amount,(int,float)) or not math.isfinite(amount) or amount<=0:return None
        if a.balance!=amount or a.equity!=amount or a.credit!=0 or a.profit!=0 or positions is None or orders is None or len(positions)!=0 or len(orders)!=0:return None
        if not isinstance(deals,(list,tuple)) or len(deals)!=1:return None
        d=deals[0]
        if d.type!=2 or d.profit!=amount or d.commission!=0 or d.swap!=0 or getattr(d,'fee',0)!=0 or d.symbol!='' or d.comment!='Deposit: DEMO':return None
        if not isinstance(d.ticket,int) or d.ticket<=0 or not isinstance(d.time_msc,int) or d.time_msc<=0:return None
        if r.get('dealId')!=str(d.ticket) or r.get('rawDealTime')!=d.time_msc:return None
        if abs(d.time_msc-received_ms)>14*3600000:return None
        return {'method':'broker-mail-opening-balance','messageId':r['messageId'],'receivedAt':r['receivedAt'],'priorBalance':amount,'currency':a.currency,'excludedDealId':str(d.ticket),'dealTimestampConverted':False}
    except (AttributeError,KeyError,TypeError,ValueError,OverflowError):return None
