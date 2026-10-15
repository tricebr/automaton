"""Bounded free GDELT GKG metadata imports. No article fetching or trading."""
import argparse,hashlib,io,json,re,zipfile
from collections import Counter
from datetime import datetime,timezone,timedelta
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlsplit
MAX_DOWNLOAD=10*1024*1024
MAX_EXPANDED=100*1024*1024

def archive_url(stamp):
 if not re.fullmatch(r'\d{14}',stamp):raise ValueError('Invalid timestamp')
 date=datetime.strptime(stamp,'%Y%m%d%H%M%S').replace(tzinfo=timezone.utc)
 if date.minute%15 or date.second or date>datetime.now(timezone.utc):raise ValueError('Invalid archive interval')
 return 'https://data.gdeltproject.org/gdeltv2/'+stamp+'.gkg.csv.zip'

def parse(raw,stamp):
 archive_url(stamp)
 if len(raw)>MAX_DOWNLOAD:raise ValueError('Archive too large')
 themes=Counter();records=translated=invalid=0;sources=set()
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  members=z.infolist()
  if len(members)!=1 or '/' in members[0].filename or '\\' in members[0].filename or members[0].file_size>MAX_EXPANDED:raise ValueError('Invalid ZIP member')
  with z.open(members[0]) as member:
   for line in io.TextIOWrapper(member,encoding='utf-8',errors='replace'):
    fields=line.rstrip('\n').split('\t')
    if len(fields)!=27 or not fields[0].startswith(stamp+'-') or fields[2]!='1':invalid+=1;continue
    try:u=urlsplit(fields[4])
    except ValueError:invalid+=1;continue
    if u.scheme not in ('http','https') or not u.hostname or u.username or u.password:invalid+=1;continue
    records+=1;translated+=fields[0].startswith(stamp+'-T');sources.add(u.hostname)
    themes.update(set(t for t in fields[7].split(';') if re.fullmatch(r'[A-Z0-9_]{1,100}',t)))
 batch=datetime.strptime(stamp,'%Y%m%d%H%M%S').replace(tzinfo=timezone.utc)
 return dict(batchAt=batch.isoformat(),assumedEarliestAvailability=(batch+timedelta(minutes=15)).isoformat(),
  downloadedAt=datetime.now(timezone.utc).isoformat(),records=records,translatedRecords=translated,sourceHosts=len(sources),invalidRecords=invalid,
  themes=themes.most_common(20),sha256=hashlib.sha256(raw).hexdigest(),source=archive_url(stamp),
  pointInTimeVerified=False,profitabilityTestEligible=False,coverage='One 15-minute archive batch, not complete daily coverage',
  limitation='Batch time plus 15 minutes is a modeling assumption, not verified historical availability. No news-strategy performance claim.')

def download(stamp,directory):
 url=archive_url(stamp);directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);target=directory/(stamp+'.zip')
 if target.exists():raw=target.read_bytes()
 else:
  with urlopen(url,timeout=25) as response:
   if response.url!=url:raise ValueError('Unexpected redirect')
   raw=response.read(MAX_DOWNLOAD+1)
  if len(raw)>MAX_DOWNLOAD:raise ValueError('Download limit exceeded')
  target.write_bytes(raw)
 result=parse(raw,stamp);(directory/(stamp+'.json')).write_text(json.dumps(result,indent=2),encoding='utf-8');return result

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--timestamps',required=True);p.add_argument('--directory',required=True);args=p.parse_args();stamps=args.timestamps.split(',')
 if len(stamps)>3:raise ValueError('At most three archive downloads per invocation')
 results=[]
 for stamp in stamps:
  try:results.append(download(stamp,args.directory))
  except Exception as error:results.append(dict(source=archive_url(stamp),status='unavailable',error=type(error).__name__,profitabilityTestEligible=False))
 summary=dict(source='GDELT GKG 2.1',archives=results,records=sum(r.get('records',0) for r in results),paidCost=0,
  completeCoverage=False,pointInTimeVerified=False,profitabilityTestEligible=False)
 (Path(args.directory)/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8');print(json.dumps(summary))
