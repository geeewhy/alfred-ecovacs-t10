// Whole-utterance grammar: questions, negation and compound requests stay chat.
export function directCommand(text) {
  if(typeof text!=='string'||text.length>1000)return null;
  let words=text.trim().toLowerCase().replace(/[.,!?]+/g,' ').replace(/\s+/g,' ').trim();
  words=words.replace(/^(?:hey )?alfred\s+/, '').replace(/^please\s+/, '').replace(/\s+please$/, '');
  if(/^(?:stop\s+)*stop(?: now| immediately)?$/.test(words))return {action:'stop',say:'Stopping.',modelMs:0};
  if(/^(?:return|go back) to (?:the )?(?:station|dock)$/.test(words))return {action:'return',say:'Returning to station.',modelMs:0};
  const match=/^go to (?:the )?(.+)$/.exec(words);
  if(match&&!/\b(?:and|then|if|or|but)\b/.test(match[1]))return {action:'navigate',section:match[1],say:`Heading to ${match[1]}.`,modelMs:0};
  return null;
}
