"""Conservative addressing gate; no model or audio dependencies."""
import re


def addressed_command(text, segments, awakened=False):
    if not segments or not all(
        s.get('no_speech_prob', 1) < .6
        and s.get('avg_logprob', -10) > -1
        and s.get('compression_ratio', 10) < 2.4
        for s in segments
    ):
        return None
    match = re.match(r'^\s*(?:(?:hey|hi|hello|okay|ok)\s+)?alfred\b[\s,:.!?-]*(.*)$', text, re.I)
    if not match:
        return text.strip() if awakened else None
    command = match.group(1).strip()
    # A name alone is a deliberate summons, not an empty command.
    return command or ('' if awakened else 'Alfred')
