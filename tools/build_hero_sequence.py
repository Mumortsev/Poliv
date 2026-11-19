"""Interpolate each 24 fps source to 60 fps and pack its frames into WebP sheets."""
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import subprocess
import tempfile

from PIL import Image

PROFILES = {
    'mobile': ('535505972_1795033316453999.mp4', ((432, 768, 66), (216, 384, 49))),
    'desktop': ('958962825_1795035774929872.mp4', ((1152, 648, 65), (480, 270, 51))),
}

def render_sheet(job):
    path, dimensions, quality, sources = job
    width, height = dimensions
    sheet = Image.new('RGB', (4 * width, 3 * height))
    for index, source in enumerate(sources):
        with Image.open(source) as frame:
            if frame.size == dimensions:
                sheet.paste(frame, (index % 4 * width, index // 4 * height))
            else:
                sheet.paste(frame.resize(dimensions, Image.Resampling.LANCZOS),
                            (index % 4 * width, index // 4 * height))
    sheet.save(path, 'WEBP', quality=quality, method=4)

def pack_video(scratch, output, dimensions, quality):
    """Pack full-resolution frames into independently decodable 0.2-second AVC blocks."""
    width, height = dimensions
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                    '-framerate','60', '-i', str(scratch / '%04d.png'),
                    '-vf', f'scale={width}:{height}', '-an', '-pix_fmt', 'yuv420p',
                    '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '4.2',
                    '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', str(quality),
                    '-x264-params', 'aud=1:repeat-headers=1:keyint=12:min-keyint=12:scenecut=0',
                    '-threads', '1', '-f', 'segment', '-segment_time', '0.2',
                    '-reset_timestamps', '1', '-segment_format', 'h264',
                    str(output / '%02d.h264')], check=True)

def main():
    with tempfile.TemporaryDirectory() as temporary:
        jobs = []
        sources = {}
        for name, (source, dimensions) in PROFILES.items():
            scratch = Path(temporary) / name
            scratch.mkdir()
            full_width, full_height, _ = dimensions[0]
            process = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', source,
                            '-filter_threads', '1', '-vf',
                            f'scale={full_width}:{full_height},tpad=stop_mode=clone:stop_duration=0.2,'
                            'minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:'
                            'me=epzs:mb_size=8:search_param=12:vsbmc=1',
                            '-frames:v', '718', '-fps_mode', 'passthrough',
                            '-threads', '1', str(scratch / '%04d.png')])
            sources[name] = (scratch, dimensions, process)
        for name, (scratch, dimensions, process) in sources.items():
            if process.wait() != 0:
                raise RuntimeError(f'{name}: frame interpolation failed')
            frames = sorted(scratch.glob('*.png'))
            if len(frames) != 718:
                raise ValueError(f'{name}: expected 718 interpolated frames, got {len(frames)}')
            for tier, (width, height, quality) in zip(('full', 'light'), dimensions):
                output = Path('site/media/sequence-hd') / name / tier
                output.mkdir(exist_ok=True, parents=True)
                for offset in range(0, len(frames), 12):
                    jobs.append((output / f'{offset // 12:02}.webp', (width, height), quality, frames[offset:offset+12]))
        with ProcessPoolExecutor(max_workers=2) as workers:
            list(workers.map(render_sheet, jobs))
        for name, (_, dimensions) in PROFILES.items():
            for tier, (width, height, _) in zip(('full', 'light'), dimensions):
                pack_video(sources[name][0], Path('site/media/sequence-hd') / name / tier,
                           (width, height), 22 if tier == 'full' else 26)

if __name__ == '__main__':
    main()
