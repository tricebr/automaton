export function outsideDialog(x,y,rect){return x<rect.left||x>rect.right||y<rect.top||y>rect.bottom;}
export function draftChanged(input){
 if(input.tagName==='SELECT'){
  const options=[...input.options],initial=options.find(option=>option.defaultSelected)??options[0];
  return input.value!==(initial?.value??'');
 }
 return input.value!==input.defaultValue;
}
export function liveTrading(data,now=Date.now()){const age=now-Date.parse(data?.observedAt);return data?.status==='connected'&&Number.isFinite(age)&&age<=15000&&age>=-1000;}
export function readableResult(result){
 if(result.kind==='drive-output')return 'Dein Ergebnis wurde '+(result.remoteStatus==='verified'?'im privaten numaron-Ordner gespeichert. Die Ablage wurde geprüft.':'zur privaten Ablage vorbereitet. Die erfolgreiche Speicherung ist noch nicht bestätigt.')+'\n\n'+(result.independentFactualVerification?'Der Inhalt wurde auch unabhängig fachlich geprüft.':'Die Ablageprüfung bestätigt die Speicherung. Der Inhalt wurde damit noch nicht unabhängig fachlich geprüft.')+'\n\nDen eigentlichen Inhalt findest du beim zugehörigen Arbeitsergebnis. Dieser Eintrag ist die Bestätigung der Ablage.';
 return result.text??result.content??JSON.stringify(result,null,2);
}
export function taskProgress(task){
 const own=task.source==='own';
 return {labels:own?['Geplant','Bearbeiten','Prüfen','Fertig']:['Geplant','Arbeiten','Automatisch prüfen','Ergebnis bereit'],current:task.status==='done'?3:['review','verifying'].includes(task.status)?2:['working','running','blocked','failed'].includes(task.status)?1:0};
}
