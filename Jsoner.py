import os
import json

def generate_architectural_manifests(root_directory):
    # Convert path to absolute to handle relative paths cleanly
    root_path = os.path.abspath(root_directory)
    
    # Check if the folder exists before running
    if not os.path.exists(root_path):
        print(f"Error: The directory '{root_directory}' does not exist.")
        return

    print(f"Scanning directory hierarchy: '{root_directory}'...")
    generated_count = 0

    # os.walk travels through all subdirectories automatically
    for current_dir, subdirs, files in os.walk(root_path):
        
        # 1. Filter out hidden system files and keep valid file extensions
        # Optional: change to `if f.lower().endswith('.art')` if you only want art files
        filtered_files = [f for f in files if not f.startswith('.')]
        
        # 2. Map immediate subdirectories so the software can navigate down the tree
        filtered_subdirs = {}
        for s in subdirs:
            if not s.startswith('.'):
                # Provide both the folder name and its path relative to the current folder
                full_sub_path = os.path.join(current_dir, s)
                rel_sub_path = os.path.relpath(full_sub_path, current_dir)
                
                filtered_subdirs[s] = {
                    "folder_name": s,
                    "relative_path": rel_sub_path.replace(os.sep, '/') # Use clean web-safe slashes
                }
        
        # 3. Assemble the structural node data object
        folder_manifest = {
            "current_folder": os.path.basename(current_dir) or "root",
            "relative_path_from_root": os.path.relpath(current_dir, root_path).replace(os.sep, '/'),
            "subfolders": filtered_subdirs,
            "files": filtered_files
        }
        
        # 4. Save the structural layout node inside its respective directory
        folder_name = os.path.basename(current_dir)
        if not folder_name:
            folder_name = "root_manifest"
            
        json_filename = f"{folder_name}_manifest.json"
        json_file_path = os.path.join(current_dir, json_filename)
        
        with open(json_file_path, 'w', encoding='utf-8') as json_file:
            json.dump(folder_manifest, json_file, indent=2, ensure_ascii=False)
            
        print(f" Generated: {os.path.relpath(json_file_path, root_path)}")
        generated_count += 1

    print(f"\nFinished! Cleanly built {generated_count} folder architecture maps.")

# --- Configuration ---
# Targets your main source folders tree
target_folder = './proto' 

if __name__ == "__main__":
    generate_architectural_manifests(target_folder)
