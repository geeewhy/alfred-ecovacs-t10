"""HTTP reads are byte fragments, never PCM sample/frame boundaries."""
class PcmFrames:
    def __init__(self, frame_bytes=2048):
        if frame_bytes<=0 or frame_bytes%2:raise ValueError('Frames must contain whole 16-bit samples')
        self.frame_bytes=frame_bytes
        self.pending=b''
    def accept(self,data):
        self.pending+=data
        frames=[]
        while len(self.pending)>=self.frame_bytes:
            frames.append(self.pending[:self.frame_bytes])
            self.pending=self.pending[self.frame_bytes:]
        return frames
