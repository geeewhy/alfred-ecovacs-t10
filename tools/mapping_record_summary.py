#!/usr/bin/env python3
"""Summarize raw mapping recordings without assuming undocumented sensor units."""
import base64, collections, json, struct, sys

def header(data, offset=0):
    seq, sec, nsec, length = struct.unpack_from('<IIII', data, offset)
    return {'seq': seq, 'stamp': sec+nsec/1e9,
            'frame': data[offset+16:offset+16+length].decode(errors='replace')}, offset+16+length

def decode(topic, data):
    if topic in ('/slam/SlamMap', '/slam/beautyMap', '/slam/finishedPathMap'):
        values = struct.unpack_from('<HHfffffI', data)
        return {'dimensions': values[:2], 'bounds': values[2:6], 'resolution': values[6],
                'cells': values[7], 'histogram': dict(collections.Counter(data[28:]))}
    if topic in ('/wheel/WheelDistanceReport', '/imu/ImuSensor'):
        h, at = header(data)
        n, = struct.unpack_from('<I', data, at)
        values = struct.unpack_from('<'+'f'*n, data, at+4)
        return {'header': h, 'values': values}
    if topic in ('/prediction/PredictPose', '/prediction/UpdatePose'):
        h, at = header(data)
        predicted = struct.unpack_from('<fff', data, at)
        h2, at2 = header(data, at+12)
        return {'header': h, 'predicted': predicted, 'poseHeader': h2,
                'pose': struct.unpack_from('<fff', data, at2)}
    if topic == '/lds/Lds':
        h, at = header(data)
        n, = struct.unpack_from('<I', data, at)
        return {'header': h, 'points': n, 'firstPoint': struct.unpack_from('<fffff', data, at+4)}
    return {'bytes': list(data[:12]), 'length': len(data)}

def summarize(path):
    topics = {}
    for line in open(path):
        row = json.loads(line)
        if row['kind'] != 'message':
            continue
        name = row['topic']
        value = decode(name, base64.b64decode(row['payload']))
        item = topics.setdefault(name, {'count': 0, 'first': value, 'start': row['receivedMono']})
        item.update(last=value, end=row['receivedMono'])
        item['count'] += 1
    for item in topics.values():
        dt = item.pop('end')-item.pop('start')
        item['rateHz'] = round((item['count']-1)/dt, 2) if dt else 0
    return topics

if __name__ == '__main__':
    print(json.dumps(summarize(sys.argv[1]), indent=2))
