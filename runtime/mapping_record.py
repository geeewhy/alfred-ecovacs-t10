#!/usr/bin/env python
"""Bounded, read-only raw TCPROS recorder. Runs on the robot with Python 2/3."""
from __future__ import print_function
import base64, ctypes, json, os, socket, sys, threading, time
import map_bridge as ros

TOPICS = ['/wheel/WheelDistanceReport', '/imu/ImuSensor', '/lds/Lds',
          '/prediction/PredictPose', '/prediction/UpdatePose',
          '/slam/SlamMap', '/slam/beautyMap', '/slam/finishedPathMap',
          '/slam/SlamMapRelocationResult', '/task/WorkState',
          '/task/MapBuildState', '/onOffInfo/slamOnOffState']

class Timespec(ctypes.Structure):
    _fields_ = [('sec', ctypes.c_long), ('nsec', ctypes.c_long)]
libc = ctypes.CDLL(None)
def monotonic():
    value = Timespec()
    if libc.clock_gettime(1, ctypes.byref(value)) != 0:
        raise RuntimeError('CLOCK_MONOTONIC unavailable')
    return value.sec + value.nsec / 1e9

def record(path, seconds):
    if not 0 < seconds <= 10:
        raise ValueError('Recording duration must be 0..10 seconds')
    lock, stop = threading.Lock(), threading.Event()
    started = monotonic()
    counts, errors = {}, {}
    with open(path, 'w') as output:
        def emit(value):
            with lock:
                if output.tell() > 32 * 1024 * 1024:
                    stop.set()
                    raise RuntimeError('32 MiB recording limit reached')
                output.write(json.dumps(value, separators=(',', ':')) + '\n')
        emit({'kind': 'session', 'version': 1, 'wallTime': time.time(),
              'monotonic': started, 'seconds': seconds, 'topics': TOPICS})
        def listen(name):
            connection = None
            try:
                pubs = dict(ros.master().getSystemState(ros.CALLER)[2][0])
                nodes = pubs.get(name, [])
                if not nodes:
                    raise RuntimeError('No publisher')
                uri = ros.master().lookupNode(ros.CALLER, nodes[0])[2]
                protocol = ros.xmlrpclib.ServerProxy(uri).requestTopic(
                    ros.CALLER, name, [['TCPROS']])[2]
                connection = socket.create_connection((protocol[1], protocol[2]), 2)
                ros.header(connection, ['callerid=/alfred_recorder', 'topic='+name,
                                        'md5sum=*', 'tcp_nodelay=1'])
                meta = ros.metadata(ros.frame(connection))
                emit({'kind': 'schema', 'topic': name, 'metadata': meta})
                counts[name] = 0
                last_map = -1e9
                while not stop.is_set() and monotonic() - started < seconds:
                    try:
                        payload = ros.frame(connection)
                    except socket.timeout:
                        continue
                    received = monotonic()
                    # Full raw map snapshots at 1 Hz; all sensor packets retained.
                    if name in ('/slam/SlamMap', '/slam/beautyMap', '/slam/finishedPathMap'):
                        if received - last_map < 1:
                            continue
                        last_map = received
                    emit({'kind': 'message', 'topic': name, 'receivedMono': received,
                          'payload': base64.b64encode(payload).decode('ascii')})
                    counts[name] += 1
            except Exception as error:
                errors[name] = str(error)
            finally:
                if connection is not None:
                    connection.close()
        threads = [threading.Thread(target=listen, args=(name,)) for name in TOPICS]
        for thread in threads:
            thread.daemon = True
            thread.start()
        for thread in threads:
            thread.join(max(0, seconds + 2.5 - (monotonic() - started)))
        stop.set()
        # Socket timeout bounds worker shutdown; do not close the output under a writer.
        for thread in threads:
            thread.join(2.1)
        emit({'kind': 'summary', 'counts': counts, 'errors': errors,
              'elapsed': monotonic() - started})
    return {'path': path, 'counts': counts, 'errors': errors}

if __name__ == '__main__':
    print(json.dumps(record(sys.argv[1], float(sys.argv[2]))))
