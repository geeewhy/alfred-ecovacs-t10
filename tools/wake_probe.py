#!/usr/bin/env python
"""Try the native quit-ERP notification, then report sleep state; no drive command."""
from __future__ import print_function
import subprocess
print(subprocess.check_output(['python','/tmp/robot_sleep_state.py']))
print(subprocess.check_output(['/usr/bin/mdsctl','rosnode','{"todo":"notifyQuitErp"}']))
for _ in range(5):
    import time
    time.sleep(1)
    output=subprocess.check_output(['python','/tmp/robot_sleep_state.py'])
    print(output)
    if '"sleeping": 0' in output:break
