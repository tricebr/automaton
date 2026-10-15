import type {SourceRecord} from './types.js';
export function sourceCatalogue():SourceRecord[] {return [
 {id:'french-daily',label:'Kenneth French: tägliche US-Faktorrenditen',kind:'factor-returns',urls:['https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_Factors_daily_CSV.zip'],allowedHosts:['mba.tuck.dartmouth.edu'],licenseStatus:'pending',licenseEvidence:'',reviewedAt:'2026-10-13'},
 {id:'jst',label:'JST Macrohistory',kind:'macro',urls:['https://www.macrohistory.net/database/'],allowedHosts:['www.macrohistory.net'],licenseStatus:'restricted',licenseEvidence:'CC BY-NC-SA 4.0; keine geschäftliche Verwendung freigegeben',reviewedAt:'2026-10-13'},
 {id:'fed-h15',label:'Federal Reserve Board: US-Treasury-Bill-Zinsen seit 1934',kind:'macro',urls:['https://www.federalreserve.gov/releases/h15/data/FRB_h15_xml.zip'],allowedHosts:['www.federalreserve.gov'],licenseStatus:'allowed',licenseEvidence:'Board-produced H15 series RIFSGFSM03_N.M; public-domain reuse with attribution: https://www.federalreserve.gov/disclaimer.htm. Download directly from Board, not FRED. Reviewed 2026-10-14.',reviewedAt:'2026-10-14'},
 ];}
