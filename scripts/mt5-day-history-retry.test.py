import unittest,importlib.util
from pathlib import Path
from types import SimpleNamespace as N
s=importlib.util.spec_from_file_location('adapter',Path(__file__).with_name('mt5-trading-adapter.py'));a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
class Tests(unittest.TestCase):
 def test_unavailable_history_recovers_once_by_repeating_complete_read(self):
  class Broker:
   def __init__(self):self.reads=0
   def history_deals_get(self,*args):self.reads+=1;return None if self.reads==1 else ()
   def history_deals_total(self,*args):return 0
  b=Broker();r=a.read_day_history(b,{'startsAt':0,'endsAt':100000},0,1000)
  self.assertTrue(r['windowVerified']);self.assertEqual(b.reads,2);self.assertEqual(r['historyReadAttempts'],2)
 def test_count_disagreement_retries_but_persistent_failure_stays_closed(self):
  class Broker:
   def __init__(self):self.reads=0
   def history_deals_get(self,*args):self.reads+=1;return ()
   def history_deals_total(self,*args):return 1
  b=Broker();r=a.read_day_history(b,{'startsAt':0,'endsAt':100000},0,1000)
  self.assertFalse(r['windowVerified']);self.assertEqual(b.reads,2);self.assertEqual(r['reasonCode'],'history-count-mismatch')
 def test_unknown_transaction_does_not_retry_into_false_empty_history(self):
  class Broker:
   DEAL_TYPE_BALANCE=2;DEAL_TYPE_BUY=0;DEAL_TYPE_SELL=1
   def __init__(self):self.reads=0
   def history_deals_get(self,*args):self.reads+=1;return (N(ticket=1,profit=10,commission=0,swap=0,fee=0,time_msc=1000,type=99,symbol=''),) if self.reads==1 else ()
   def history_deals_total(self,*args):return 1
  b=Broker();r=a.read_day_history(b,{'startsAt':0,'endsAt':100000},0,1000);self.assertFalse(r['windowVerified']);self.assertEqual(b.reads,1)
 def test_lifetime_snapshot_can_recover_but_real_conflicts_never_retry(self):
  from unittest.mock import patch
  spec=importlib.util.spec_from_file_location('fixtures',Path(__file__).with_name('mt5-demo-credit-proof.test.py'));fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
  import copy
  for mode in ['unavailable','empty','additional-deal','conflicting-window','conflicting-incomplete-account']:
   receipt,account,deal,window=fixtures.Tests().fixture()
   class Broker:
    DEAL_TYPE_BALANCE=2;DEAL_TYPE_BUY=0;DEAL_TYPE_SELL=1
    def __init__(self):self.wide=0;self.full=0
    def history_deals_get(self,begin,end):
     if begin.year==1970:
      self.full+=1
      if self.full==1 and mode=='unavailable':return None
      if self.full==1 and mode=='empty':return ()
      if mode=='additional-deal':return (deal,copy.copy(deal))
      if mode=='conflicting-incomplete-account':
       row=copy.copy(deal);row.profit=49999;return (row,)
      return (deal,)
     self.wide+=1;row=copy.copy(deal)
     if mode=='conflicting-window':row.profit=49999
     return (row,)
    def history_deals_total(self,begin,end):
     if begin.year!=1970:return 1
     return None if mode=='unavailable' and self.full==1 else 0 if mode=='empty' and self.full==1 else 2 if mode=='additional-deal' else 1
    def account_info(self):return None if mode=='conflicting-incomplete-account' else account
    def positions_get(self):return ()
    def orders_get(self):return ()
   b=Broker()
   with patch.object(a._credit_module,'load_receipt',return_value=receipt):r=a.read_day_history(b,window,10800,1792109700000,{'account':'123','server':'AdmiralsGroup-Demo'})
   recoverable=mode in ['unavailable','empty'];self.assertEqual(r['windowVerified'],recoverable,mode);self.assertEqual(b.wide,2 if recoverable else 1,mode)

 def test_unknown_record_with_disagreeing_count_cannot_retry_to_empty(self):
  class Broker:
   DEAL_TYPE_BALANCE=2;DEAL_TYPE_BUY=0;DEAL_TYPE_SELL=1
   def __init__(self):self.reads=0
   def history_deals_get(self,*args):self.reads+=1;return (N(ticket=1,profit=10,commission=0,swap=0,fee=0,time_msc=1000,type=99,symbol=''),) if self.reads==1 else ()
   def history_deals_total(self,*args):return 0
  b=Broker();r=a.read_day_history(b,{'startsAt':0,'endsAt':100000},0,1000);self.assertFalse(r['windowVerified']);self.assertEqual(b.reads,1)
 def test_known_opening_record_cannot_disappear_during_retry(self):
  from unittest.mock import patch
  spec=importlib.util.spec_from_file_location('fixtures',Path(__file__).with_name('mt5-demo-credit-proof.test.py'));fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures);receipt,account,deal,window=fixtures.Tests().fixture()
  class Broker:
   DEAL_TYPE_BALANCE=2;DEAL_TYPE_BUY=0;DEAL_TYPE_SELL=1
   def __init__(self):self.wide=0
   def history_deals_get(self,begin,end):
    if begin.year==1970:return None
    self.wide+=1;return (deal,) if self.wide==1 else ()
   def history_deals_total(self,begin,end):return None if begin.year==1970 else 1 if self.wide==1 else 0
  b=Broker()
  with patch.object(a._credit_module,'load_receipt',return_value=receipt):r=a.read_day_history(b,window,10800,1792109700000,{'account':'123','server':'AdmiralsGroup-Demo'})
  self.assertFalse(r['windowVerified']);self.assertEqual(r['reasonCode'],'history-records-changed-during-retry');self.assertEqual(b.wide,2)

if __name__=='__main__':unittest.main()
