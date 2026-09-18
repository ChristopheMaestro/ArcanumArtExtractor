import os
import struct
import numpy as np
from PIL import Image

def extract_first_frame_as_gif(file_path, base_art_dir, base_extract_dir):
    """
    1. Extracts ONLY the very first frame from a given .ART asset.
    2. Converts it directly into an optimized, alpha-transparent .gif thumbnail.
    3. Retains the original nested folder structure under the extraction target.
    """
    filename = os.path.basename(file_path)
    base_name = os.path.splitext(filename)[0]

    # Calculate relative subfolder path to retain the original folder hierarchy
    relative_path = os.path.relpath(os.path.dirname(file_path), base_art_dir)
    if relative_path == ".":
        target_output_dir = base_extract_dir
    else:
        target_output_dir = os.path.join(base_extract_dir, relative_path)

    os.makedirs(target_output_dir, exist_ok=True)
    gif_path = os.path.join(target_output_dir, f"{base_name}.gif")

    with open(file_path, "rb") as f:
        data = f.read()

    if len(data) < 0x84:
        print(f"Skipping {filename}: File too small to contain valid headers.")
        return

    # 1. Parse THead Header Structure (array[$00..$20] of DWORD = 33 elements)
    head_words = struct.unpack(f"<{33}I", data[0:0x84])
    
    # Determine Palette Quantities inside file boundaries
    if head_words[6] != 0: palette_count = 4
    elif head_words[5] != 0: palette_count = 3
    elif head_words[4] != 0: palette_count = 2
    else: palette_count = 1

    current_offset = 0x84

    # 2. Extract Color Palettes (Each palette is 256 entries * 4 bytes BGRA)
    palettes_rgb_tuples = []
    for _ in range(palette_count):
        pal_bytes = data[current_offset:current_offset + 1024]
        current_offset += 1024
        
        pal_entries = []
        for p_idx in range(256):
            b, g, r, _ = struct.unpack("4B", pal_bytes[p_idx*4 : (p_idx+1)*4])
            pal_entries.append((r, g, b))
        palettes_rgb_tuples.append(pal_entries)

    # Use first palette channel as primary default reference layout
    active_palette_tuples = palettes_rgb_tuples[0]

    # 3. Read Picture / Frame indexing structures to fast forward offset
    if head_words[0] in (0, 2):
        picture_count = 8
        frame_count = head_words[8]
    else:
        picture_count = head_words[8]
        frame_count = 1
    total_images = picture_count * frame_count

    # Extract info for the first frame
    first_img_info_bytes = data[current_offset:current_offset + 28]
    w, h, compressed_size, left, top, delta_x, delta_y = struct.unpack("<3I4i", first_img_info_bytes)
    
    # Fast forward global offset past all remaining image info blocks to hit the payloads
    current_offset += 28 * total_images

    if w == 0 or h == 0:
        print(f"Skipping {filename}: First frame has 0 dimensions.")
        return

    # 4. Decompress Pixel Payload for the FIRST image asset only
    img_data_chunk = data[current_offset:current_offset + compressed_size]
    pixel_indices = bytearray()

    if w * h == compressed_size:
        pixel_indices = bytearray(img_data_chunk)
    else:
        # Execute Run-Length Encoding Decompression Routine matching Delphi specs
        src_ptr = 0
        while src_ptr < len(img_data_chunk):
            control_byte = img_data_chunk[src_ptr]
            src_ptr += 1
            
            is_repeating = (control_byte & 0x80) == 0
            count = control_byte & 0x7F

            if is_repeating:
                repeat_val = img_data_chunk[src_ptr]
                src_ptr += 1
                pixel_indices.extend([repeat_val] * count)
            else:
                pixel_indices.extend(img_data_chunk[src_ptr:src_ptr + count])
                src_ptr += count

    # Normalize boundaries
    if len(pixel_indices) < (w * h):
        pixel_indices.extend([0] * ((w * h) - len(pixel_indices)))
    else:
        pixel_indices = pixel_indices[:w * h]

    # ----------------------------------------------------
    # STAGE 2: Map Palette, Handle Transparency, and Optimize GIF
    # ----------------------------------------------------
    try:
        index_matrix = np.array(pixel_indices, dtype=np.uint8).reshape((h, w))
        rgba_canvas = np.zeros((h, w, 4), dtype=np.uint8)

        for y in range(h):
            for x in range(w):
                color_index = index_matrix[y, x]
                r, g, b = active_palette_tuples[color_index]
                
                rgba_canvas[y, x, 0] = r
                rgba_canvas[y, x, 1] = g
                rgba_canvas[y, x, 2] = b
                
                # Target pure background color #0000FF to make completely transparent
                if r == 0 and g == 0 and b == 255:
                    rgba_canvas[y, x, 3] = 0
                else:
                    rgba_canvas[y, x, 3] = 255

        # Create RGBA Image
        img_rgba = Image.fromarray(rgba_canvas, 'RGBA')
        
        # Split into RGB and Alpha channels to handle transparent masks properly
        alpha = img_rgba.split()[3]
        img_rgb = img_rgba.convert("RGB")
        
        # Convert RGB to a lightweight adaptive palette image (leaving 1 index slot free)
        img_gif = img_rgb.convert("P", palette=Image.Palette.ADAPTIVE, colors=255)
        
        # Generate a binary mask where 0 is fully transparent (thresholded at 128)
        mask = alpha.point(lambda p: 255 if p < 128 else 0)
        
        # Inject the transparency mask directly into index 255 of the final structural layer
        img_gif.paste(255, mask)
        
        # Save optimized single frame GIF with index 255 flagged as the transparency key
        img_gif.save(gif_path, "GIF", optimize=True, transparency=255)
        print(f"   Success -> '{os.path.join(relative_path, base_name)}.gif'")

    except Exception as conv_err:
        print(f"   GIF creation failed for {filename}: {conv_err}")

def run_extraction_pipeline():
    source_art_dir = "./art"
    base_extract_dir = "./extract"

    if not os.path.exists(source_art_dir):
        print(f"Error: Could not locate source folder path: '{source_art_dir}'.")
        return

    print(f"Initializing optimized thumbnail pipeline on target: '{source_art_dir}'...")
    processed_files = 0

    # os.walk ensures it searches recursively through all nested folders
    for root, dirs, files in os.walk(source_art_dir):
        for filename in files:
            if filename.lower().endswith('.art'):
                file_path = os.path.join(root, filename)
                try:
                    extract_first_frame_as_gif(file_path, source_art_dir, base_extract_dir)
                    processed_files += 1
                except Exception as file_err:
                    print(f"   Critical error processing '{filename}': {file_err}")

    print(f"\nPipeline Finished! Created {processed_files} lightweight .gif thumbnails.")

if __name__ == "__main__":
    run_extraction_pipeline()
