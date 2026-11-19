"""Extract the original 24 fps hero frames and package twelve per WebP image."""
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import subprocess
import tempfile

from PIL import Image

PROFILES = {
    'mobile': ('535505972_1795033316453999.mp4', ((288, 512, 58), (108, 192, 42))),
    'desktop': ('958962825_1795035774929872.mp4', ((768, 432, 60), (192, 108, 45))),
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

def main():
    with tempfile.TemporaryDirectory() as temporary:
        jobs = []
        for name, (source, dimensions) in PROFILES.items():
            scratch = Path(temporary) / name
            scratch.mkdir()
            full_width, full_height, _ = dimensions[0]
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', source,
                            '-vf', f'scale={full_width}:{full_height}', '-fps_mode', 'passthrough',
                            '-threads', '1', str(scratch / '%04d.png')], check=True)
            frames = sorted(scratch.glob('*.png'))
            if len(frames) != 287:
                raise ValueError(f'{name}: expected 287 original frames, got {len(frames)}')
            for tier, (width, height, quality) in zip(('full', 'light'), dimensions):
                output = Path('site/media/sequence') / name / tier
                output.mkdir(exist_ok=True, parents=True)
                for offset in range(0, len(frames), 12):
                    jobs.append((output / f'{offset // 12:02}.webp', (width, height), quality, frames[offset:offset+12]))
        with ProcessPoolExecutor(max_workers=2) as workers:
            list(workers.map(render_sheet, jobs))

if __name__ == '__main__':
    main()
