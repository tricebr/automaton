"""Synthetic opening-balance evidence; no provider credentials or terminals."""
import unittest, importlib.util, copy
from pathlib import Path
from types import SimpleNamespace as N
spec=importlib.util.spec_from_file_location('credit',Path(__file__).with_name('mt5-demo-credit-proof.py'))
credit=importlib.util.module_from_spec(spec);spec.loader.exec_module(credit)
class Tests(unittest.TestCase):
    def fixture(self):
        receipt={'schemaVersion':1,'kind':'admirals-demo-opening-balance','account':'123','server':'AdmiralsGroup-Demo','currency':'EUR','balance':50000,'receivedAt':'2026-10-15T17:14:10+00:00','brokerDate':'2026-10-15T17:14:10+00:00','sender':'global@admiralmarkets.com','messageId':'a'*16,'dkimPass':True,'dmarcPass':True,'accountConfirmed':True,'serverConfirmed':True,'newDemoAccountConfirmed':True,'balanceConfirmed':True,'dealId':'7','rawDealTime':1792095248192}
        account=N(login=123,server='AdmiralsGroup-Demo',trade_mode=0,currency='EUR',balance=50000,equity=50000,credit=0,profit=0)
        deal=N(ticket=7,type=2,profit=50000,commission=0,swap=0,fee=0,symbol='',comment='Deposit: DEMO',time_msc=1792095248192)
        window={'startsAt':1792101600000,'endsAt':1792188000000}
        return receipt,account,deal,window
    def verify(self,r,a,d,w,**kw):return credit.verify_demo_opening_credit(r,a,[d],w,1792109700000,positions=[],orders=[],**kw)
    def test_full_broker_mail_before_day_and_sole_matching_demo_credit_prove_prior_balance(self):
        r,a,d,w=self.fixture();proof=self.verify(r,a,d,w)
        self.assertEqual(proof['method'],'broker-mail-opening-balance');self.assertEqual(proof['priorBalance'],50000);self.assertFalse(proof['dealTimestampConverted']);self.assertEqual(proof['excludedDealId'],'7')
    def test_identity_authentication_amount_date_and_provenance_must_all_match(self):
        cases=[('account','999'),('server','other'),('balance',49999),('currency','USD'),('sender','attacker@example.com'),('dkimPass',False),('dmarcPass',False),('accountConfirmed',False),('balanceConfirmed',False),('newDemoAccountConfirmed',False),('receivedAt','2026-10-16T00:00:00+00:00'),('receivedAt','2026-10-15T17:14:10'),('brokerDate','2026-10-14T17:14:10+00:00'),('dealId','8'),('rawDealTime',1792095248193)]
        for field,value in cases:
            r,a,d,w=self.fixture();r[field]=value;self.assertIsNone(self.verify(r,a,d,w),field)
    def test_real_contest_trading_fees_credit_exposure_or_changed_balance_do_not_pass(self):
        for field,value in [('trade_mode',2),('trade_mode',1),('balance',50001),('equity',49999),('profit',1),('credit',1)]:
            r,a,d,w=self.fixture();setattr(a,field,value);self.assertIsNone(self.verify(r,a,d,w))
        for field,value in [('type',0),('profit',49999),('commission',1),('swap',1),('fee',1),('symbol','EURUSD'),('comment','Deposit')]:
            r,a,d,w=self.fixture();setattr(d,field,value);self.assertIsNone(self.verify(r,a,d,w))
        r,a,d,w=self.fixture()
        for deals,positions,orders in [([d,copy.copy(d)],[],[]),([d],[N()],[]),([d],[],[N()])]:self.assertIsNone(credit.verify_demo_opening_credit(r,a,deals,w,1792109700000,positions=positions,orders=orders))
    def test_adapter_anchors_only_exact_complete_lifetime_history_and_keeps_original_record(self):
        from unittest.mock import patch
        source=importlib.util.spec_from_file_location('adapter',Path(__file__).with_name('mt5-trading-adapter.py'));adapter=importlib.util.module_from_spec(source);source.loader.exec_module(adapter)
        receipt,account,deal,window=self.fixture()
        class Broker:
            DEAL_TYPE_BALANCE=2;DEAL_TYPE_BUY=0;DEAL_TYPE_SELL=1
            def history_deals_get(self,*args):return (deal,)
            def history_deals_total(self,*args):return 1
            def account_info(self):return account
            def positions_get(self):return ()
            def orders_get(self):return ()
        binding={'account':'123','server':'AdmiralsGroup-Demo'}
        with patch.object(adapter._credit_module,'load_receipt',return_value=receipt):
            result=adapter.read_day_history(Broker(),window,10800,1792109700000,binding)
        self.assertTrue(result['windowVerified']);self.assertEqual(result['cashFlows'],[]);self.assertEqual(result['recordCount'],1);self.assertFalse(result['wideIntervalEmpty']);self.assertEqual(result['excludedPriorDayRecords'][0]['id'],'7');self.assertTrue(result['dayIntervalEmpty'])
        class Conflicting(Broker):
            def history_deals_get(self,begin,end):
                row=copy.copy(deal)
                if begin.year!=1970:row.profit=49999
                return (row,)
        with patch.object(adapter._credit_module,'load_receipt',return_value=receipt):
            self.assertFalse(adapter.read_day_history(Conflicting(),window,10800,1792109700000,binding)['windowVerified'])
        class Incomplete(Broker):
            def history_deals_total(self,begin,end):return 2 if begin.year==1970 else 1
        with patch.object(adapter._credit_module,'load_receipt',return_value=receipt):
            self.assertFalse(adapter.read_day_history(Incomplete(),window,10800,1792109700000,binding)['windowVerified'])
        with patch.object(adapter._credit_module,'load_receipt',return_value=None):
            self.assertFalse(adapter.read_day_history(Broker(),window,10800,1792109700000,binding)['windowVerified'])
if __name__=='__main__':unittest.main()
