export function outsideDialog(x,y,rect){return x<rect.left||x>rect.right||y<rect.top||y>rect.bottom;}
const explanations=[
 [/mission fortschritt/i,'Anteil der abgeschlossenen Missionen an den aktuell erfassten Missionen. Wartende, fehlgeschlagene und noch geprüfte Aufgaben zählen nicht als abgeschlossen.'],
 [/meilenstein|erster kontakt|momentum|konstellation/i,'Eine Auszeichnung für tatsächlich abgeschlossene Missionen: Erster Kontakt ab 1, Momentum ab 10 und Konstellation ab 50. Das bewertet den Arbeitsfortschritt, nicht den finanziellen Erfolg.'],
 [/ki.kern|ai.kern|system online|founder os/i,'Der KI-Kern zeigt den gemeldeten Betriebszustand von numaron. Bewegung bedeutet eingeschalteter Betrieb; sie ist kein Nachweis, dass gerade ein bestimmter Auftrag ausgeführt wird.'],
 [/mission control|das läuft|offene mission|laufende arbeit|aktuell in bearbeitung/i,'Hier siehst du geplante, wartende, laufende oder noch geprüfte Aufgaben. Der Status jeder Mission zeigt, ob sie gerade bearbeitet wird oder noch wartet.'],
 [/budget|kostenkontrolle|reserviert/i,'Budget ist der erlaubte Kostenrahmen. Reservierungen halten Geld für mögliche Aufrufe frei; sie sind noch keine bestätigten Ausgaben.'],
 [/gewinn|netto/i,'Gewinn ergibt sich aus Einnahmen abzüglich der vollständigen Ausgaben. Solange Belege oder Kosten fehlen, bleibt der angezeigte Wert vorläufig.'],
 [/einnahmen|zahlungseing/i,'Einnahmen sind nachgewiesene Zahlungseingänge im gewählten Zeitraum. Sie sind noch kein Gewinn; Gebühren, Rückzahlungen und weitere Kosten werden getrennt betrachtet.'],
 [/amplitude|website.*dashboard|seitenaufruf|dashboard.aufruf/i,'Amplitude zählt die erfassten Seiten- und Dashboard-Aufrufe. Wiederholte Besuche zählen mehrfach; die Zahlen sind keine Anzahl verschiedener Personen. Lokale Prüfaufrufe können enthalten sein.'],
 [/swap/i,'Swap bezeichnet laufende Finanzierungskosten oder Gutschriften für über Nacht gehaltene Handelspositionen. Höhe und Bedingungen hängen vom Broker und Instrument ab.'],
 [/spread/i,'Der Spread ist der Abstand zwischen Kauf- und Verkaufskurs. Er gehört zu den Handelskosten und kann sich mit Markt und Liquidität verändern.'],
 [/equity/i,'Equity ist der aktuelle Kontowert einschließlich der noch nicht realisierten Gewinne und Verluste offener Positionen.'],
 [/paper|vorwärtstest/i,'Ein Paper- oder Vorwärtstest beobachtet eine Strategie ohne reale Orders. Seine Ergebnisse sind Forschungsdaten und kein Nachweis für künftig erreichbare Gewinne.'],
 [/trading radar|trades im blick|marktbeobachtung/i,'Das Radar sammelt und prüft Marktbeobachtungen. Eine Beobachtung oder ein Signal ist keine ausgeführte Order und keine automatische Handelsfreigabe.'],
 [/langzeit|marktgeschichte|forschungslabor|research lab|historisch/i,'Hier untersucht numaron historische Daten und Strategien. Erkenntnisse werden dokumentiert; Datenlücken und unbestätigte Annahmen begrenzen ihre Aussagekraft.'],
 [/risiko|stop.loss|stopabstand/i,'Der Risikorahmen beschreibt mögliche Verlustgrenzen. Ein Stop begrenzt das geplante Risiko, garantiert bei Kurslücken aber keinen bestimmten Ausführungspreis.'],
 [/prüf|freigab|braucht dich/i,'Hier geht es um konkrete Prüfungen oder Entscheidungen. Eine Inhaltsprüfung bestätigt die gezeigte Version; sie ist keine pauschale Erlaubnis für Zahlungen, Veröffentlichung oder Handel.'],
 [/ergebnis|das ist bereit|lieferung|werkstatt/i,'Ergebnisse sind gespeicherte Arbeitsergebnisse oder verfügbare Dateien. Ein fertiges Ergebnis bedeutet noch keine Kundenabnahme und keinen Zahlungseingang.'],
 [/auftrag|aufgabe|recherche/i,'numaron zerlegt Vorhaben in Aufgaben. Je nach verfügbaren Fähigkeiten werden Quellen recherchiert, Inhalte ausgearbeitet oder Ergebnisse überprüft. Der angezeigte Status beschreibt den tatsächlichen Arbeitsstand.'],
 [/betrieb|controller|not.aus/i,'Die Betriebssteuerung schaltet die KI-Arbeit ein, pausiert oder stoppt sie. Bereits versandte Anfragen können trotzdem Kosten verursachen. Offene Trades werden dadurch nicht geschlossen.'],
];
export function explainTerm(label){return explanations.find(([pattern])=>pattern.test(label))?.[1]??null;}
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
