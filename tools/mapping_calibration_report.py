#!/usr/bin/env python3
"""Compare a completed motion recording with independently measured floor marks."""
import argparse,json,math
from pathlib import Path

def assess(recording, distance_mm=None, angle_deg=None, separation_mm=243.):
    if recording.get('error') or not recording.get('commands'):
        raise ValueError('A failed or command-free recording cannot establish calibration')
    if not recording.get('settled'):
        raise ValueError('Recording does not confirm a stationary stop; repeat with the current recorder')
    samples=recording.get('samples',[])
    if len(samples)<2:raise ValueError('Recording has no wheel baseline')
    wheels=[s['native']['wheels'] for s in samples]
    boots={s['native'].get('boot_id') for s in samples}
    if len(boots)!=1 or None in boots:raise ValueError('Missing or changed robot boot identity')
    if any(w.get('age_ms') is None or w['age_ms']>300 for w in wheels):
        raise ValueError('Recording contains stale wheel measurements')
    if not math.isfinite(separation_mm) or separation_mm<=0:raise ValueError('Invalid wheel separation')
    if any(not math.isfinite(v) for w in wheels for v in w['values']):raise ValueError('Nonfinite wheel measurement')
    delta=[wheels[-1]['values'][i]-wheels[0]['values'][i] for i in range(2)]
    distance=sum(delta)/2
    angle=math.degrees((delta[1]-delta[0])/separation_mm)
    if recording['mode']=='forward':
        if distance_mm is None or not math.isfinite(distance_mm) or distance_mm<=0:
            raise ValueError('Supply the independently measured positive --distance-mm')
        error=distance-distance_mm
        return {'kind':'distance','measured_mm':distance_mm,'wheel_mm':distance,
                'error_mm':error,'within_50mm':abs(error)<=50,
                'one_metre_gate':abs(distance_mm-1000)<=50 and abs(error)<=50,
                'suggested_distance_scale':distance_mm/distance if distance>0 else None}
    if angle_deg is None or not math.isfinite(angle_deg) or angle_deg==0:
        raise ValueError('Supply signed --angle-deg: counterclockwise positive')
    error=angle-angle_deg
    return {'kind':'rotation','measured_deg':angle_deg,'wheel_deg':angle,
            'error_deg':error,'within_5deg':abs(error)<=5,
            'ninety_degree_gate':abs(abs(angle_deg)-90)<=5 and abs(error)<=5,
            'suggested_separation_mm':separation_mm*angle/angle_deg if angle*angle_deg>0 else None}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('recording',type=Path);p.add_argument('--distance-mm',type=float)
    p.add_argument('--angle-deg',type=float);p.add_argument('--separation-mm',type=float,default=243.)
    args=p.parse_args()
    if not math.isfinite(args.separation_mm) or args.separation_mm<=0:p.error('Wheel separation must be positive')
    try:result=assess(json.loads(args.recording.read_text()),args.distance_mm,args.angle_deg,args.separation_mm)
    except (ValueError,KeyError,IndexError) as error:p.error(str(error))
    result.update(recording=str(args.recording.resolve()),applied=False)
    destination=args.recording.with_suffix('.calibration.json')
    destination.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(result,report=str(destination))))
if __name__=='__main__':main()
