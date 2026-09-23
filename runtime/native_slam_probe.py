#!/usr/bin/env python
"""Bounded native SLAM START/STOP probe; does not command wheels or cleaning."""
from __future__ import print_function
import json, socket, struct, threading, time
try:
    from SimpleXMLRPCServer import SimpleXMLRPCServer
except ImportError:
    from xmlrpc.server import SimpleXMLRPCServer
import map_bridge as ros

TOPIC = '/slam/SlamControl'
def probe(seconds=5):
    master = ros.master()
    pub = dict(master.getSystemState(ros.CALLER)[2][0])[TOPIC][0]
    uri = master.lookupNode(ros.CALLER, pub)[2]
    proto = ros.xmlrpclib.ServerProxy(uri).requestTopic(ros.CALLER, TOPIC, [['TCPROS']])[2]
    s = socket.create_connection((proto[1], proto[2]), 2)
    try:
        ros.header(s, ['callerid=/alfred_slam_probe', 'topic='+TOPIC, 'md5sum=*'])
        meta = ros.metadata(ros.frame(s))
    finally:
        s.close()
    # Refuse unknown control layouts; START and STOP are the shipped constants.
    compact = '\n'.join(x.split('#')[0].strip() for x in meta['message_definition'].splitlines())
    for required in ('uint8 SLAM_CONTROL_START = 0', 'uint8 SLAM_CONTROL_STOP = 1', 'uint8 type'):
        if required.replace(' ', '') not in compact.replace(' ', ''):
            raise RuntimeError('Unsupported control schema: '+compact)
    server = socket.socket(); server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', 0)); server.listen(8); server.settimeout(.2)
    rpc = SimpleXMLRPCServer(('127.0.0.1', 0), logRequests=False, allow_none=True)
    rpc.register_function(lambda *args: [1, '', ['TCPROS', '127.0.0.1', server.getsockname()[1]]], 'requestTopic')
    rpc.register_function(lambda *args: [1, '', 0], 'getPid')
    thread = threading.Thread(target=rpc.serve_forever); thread.daemon=True; thread.start()
    address = 'http://127.0.0.1:%d' % rpc.server_address[1]
    clients=[]
    before=ros.snapshot()
    master.registerPublisher('/alfred_slam_probe', TOPIC, meta['type'], address)
    try:
        deadline=time.time()+3
        while time.time()<deadline:
            try:
                c,_=server.accept(); c.settimeout(1); ros.metadata(ros.frame(c))
                ros.header(c, ['callerid=/alfred_slam_probe','type='+meta['type'],
                              'md5sum='+meta['md5sum'],'message_definition='+meta['message_definition']])
                clients.append(c)
                break
            except socket.timeout: pass
        if not clients: raise RuntimeError('No native SLAM subscriber connected')
        for c in clients:c.sendall(struct.pack('<IB',1,0))
        time.sleep(seconds)
        after=ros.snapshot()
        for state in (before,after):
            if 'grid' in state:state['grid'].pop('png',None)
        return {'before':before,'after':after,'subscribers':len(clients),'schema':meta}
    finally:
        for c in clients:
            try:c.sendall(struct.pack('<IB',1,1));c.close()
            except Exception:pass
        master.unregisterPublisher('/alfred_slam_probe',TOPIC,address)
        rpc.shutdown();server.close()

if __name__=='__main__':
    print(json.dumps(probe(2)))
