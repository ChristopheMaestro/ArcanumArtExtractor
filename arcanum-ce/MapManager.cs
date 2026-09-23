using System.Collections.Generic;
using System.Linq;
using System.Collections;
using UnityEngine;
using UnityEngine.Tilemaps;
using System;
using System.IO;
using System.Threading.Tasks;
using GlobalScript;
using Movement;
using Prototypes;
using Graphics;
using Objects;

namespace Tiles
{
    public class NewTileData
    {
        public string type = "ill";
        public string list = "inUnflipFlags"; //"outFlip" / "subtypes" / "inFlip" / "inUnflip" / "outUnflip" / "Facades"
        public int ID = 0;
        public bool flipped = false;
        public bool blocked = false; //only for facades (regular tiles derive this flag from the TilesetNames script)
        public Vector2Int position = new Vector2Int(-1, -1); //position within sector
        public Vector2Int globalPosition = new Vector2Int(-1, -1); //world position
    }

    public class NewRoofData
    {
        public string art = null;
        public int ID = -1;
        public bool flipped = false;
    }

    public class MapManager : MonoBehaviour
    {
        private static MapManager _instance;
        public static MapManager Instance { get { return _instance; } }

        private static Grid grid;
        public static float pixelSize; //size of a tilemap pixel in world units
        public static Vector2Int cellSizePixels = new Vector2Int(78, 40); //size of a tilemap cell in pixels
        public static Vector2 cellSizeWorld; //size of a tilemap cell in world units
        public static Dictionary<Vector2Int, TileData> dataFromTiles = new Dictionary<Vector2Int, TileData>();
        public static Dictionary<Vector2Int, List<GameObject>> objectIndex = new Dictionary<Vector2Int, List<GameObject>>(); //list of objects within each sector
        public static Dictionary<Vector2Int, Tilemap> roofTilemaps = new Dictionary<Vector2Int, Tilemap>();

        public static Grid GetGrid
        {
            get
            {
                if (grid == null)
                {
                    grid = Instance.gameObject.GetComponent<Grid>();
                }
                return grid;
            }
        }

        private static Vector2Int startCoords = new Vector2Int(62243, 65664);
        private const int renderDistance = 1; //radius, not diameter
        public const int sectorDimsTiles = 64; //dimensions of a single sector (in tiles)
        public static Vector2 sectorDimsWorld; //dimensions of a single sector (in world units)
        public const int tilesTotal = sectorDimsTiles * sectorDimsTiles;
        public const int sectorDimsRoofs = sectorDimsTiles / 4; //dimensions of a single sector (in roofs)
        public const int roofTileDims = 4;
        public const int roofsTotal = sectorDimsRoofs * sectorDimsRoofs;
        static int worldHeight = -1, worldWidth = worldHeight; //width and height of the world map
        const int maxSectors = 25; //max number of sectors loaded simultaneously

        public GameObject sectorPrefab;
        public GameObject roofsPrefab;
        public GameObject wallPrefab;
        public GameObject portalPrefab;
        public GameObject sceneryPrefab;

        public Transform sectorParent;
        public Transform roofParent;
        public Transform wallParent;
        public Transform portalParent;
        public Transform sceneryParent;

        static private Vector2 wallOffsetNorthwest;
        static private Vector2 wallOffsetNortheast;
        static private Vector2 wallOffsetSouthheast;

        static private Color colNE = new Color(0.5f, 0.5f, 0.5f, 1f);
        static private Color colSE = new Color(0.8f, 0.8f, 0.8f, 1f);
        static private Color colNW = new Color(0.4f, 0.4f, 0.4f, 1f);

        private static byte[] globalMapData = new byte[4000000]; //empty sector data from the global map
        public static HashSet<Vector2Int> toLoadSectors = new HashSet<Vector2Int>();
        public static Dictionary<Vector2Int, Tilemap> loadedSectors = new Dictionary<Vector2Int, Tilemap>();

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(this.gameObject);
            }
            else
            {
                _instance = this;
            }

            cellSizeWorld = (Vector2)GetGrid.cellSize; //get tile dimensions
            pixelSize = cellSizeWorld.x / GlobalScript.Global.pixelsPerUnit; //get pixel dimensions
            sectorDimsWorld = cellSizeWorld * sectorDimsTiles; //get sector dimensions

            //get wall offsets for different directions
            wallOffsetNorthwest = new Vector2(-37 * pixelSize, 20 * pixelSize);
            wallOffsetNortheast = new Vector2(39 * pixelSize, 19 * pixelSize);
            wallOffsetSouthheast = new Vector2(2 * pixelSize, 0);

            GetGlobalMapDimensions(); //get global map dimensions
        }

        private void Start()
        {
            TeleportPlayer(startCoords);
        }

        void Update()
        {

        }

        private void CreateTile(NewTileData data, Tilemap tilemap)
        {
            Vector3Int position = (Vector3Int)data.position;
            string art = data.type;
            if (data.list == "facades")
            {
                art = "Facades/" + art + "_" + data.ID;
            }
            else
            {
                if (data.list != "subtypes")
                {
                    art += "bse";
                }

                art = "Regular/" + art + "_" + data.ID;
            }

            TileBase tile = Resources.Load<Tile>("Tiles/" + art); //load tile sprite
            if (tile == null) //check if tile sprite exists
            {
                Debug.Log("Invalid tile sprite at: " + data.globalPosition.x + ", " + data.globalPosition.y + "; " + art);
                tile = Resources.Load<Tile>("Tiles/Regular/drttst_8");
            }

            if (_instance == null) //prevents bugs if the game stops running while a sector file is being read
            {
                return;
            }

            tilemap.SetTile(position, tile);
            tilemap.SetTileFlags(position, TileFlags.None); //clear tile flags so it can be tinted later

            if (data.flipped) //flip
            {
                tilemap.SetTransformMatrix(position, Matrix4x4.Scale(new Vector3(-1f, 1f, 1f)));
            }

            if (!dataFromTiles.ContainsKey(data.globalPosition))
            {
                dataFromTiles.Add(data.globalPosition, new TileData());
                dataFromTiles[data.globalPosition].position = data.globalPosition;
                dataFromTiles[data.globalPosition].isFlipped = data.flipped;

                tileFlags[] list = new tileFlags[0];
                if (data.list == "subtypes") //get primary base tileset of edge tileset
                {
                    data.type = data.type.Substring(0, 3);
                    if (System.Array.Exists(TilesetNames.outFlipFlags, x => x.name == data.type))
                    {
                        list = TilesetNames.outFlipFlags;
                    }
                    else if (System.Array.Exists(TilesetNames.outUnflipFlags, x => x.name == data.type))
                    {
                        list = TilesetNames.outUnflipFlags;
                    }
                    else if (System.Array.Exists(TilesetNames.inUnflipFlags, x => x.name == data.type))
                    {
                        list = TilesetNames.inUnflipFlags;
                    }
                }

                if (data.list == "outFlip") //get the list of flags
                {
                    list = TilesetNames.outFlipFlags;
                }
                else if (data.list == "outUnflip")
                {
                    list = TilesetNames.outUnflipFlags;
                }
                else if (data.list == "inUnflip")
                {
                    list = TilesetNames.inUnflipFlags;
                }

                if (list.Count() != 0) //pass flags
                {
                    int index = System.Array.FindIndex(list, x => x.name == data.type);
                    dataFromTiles[data.globalPosition].flags = list[index].flags;
                }

                if (data.blocked) //blocked facades & tiles blocked in the editor
                {
                    TileOperations.SetBlocked(ref dataFromTiles[data.globalPosition].flags, true);
                }
            }
        }

        private void CreateRoof(NewRoofData data, Tilemap roofs, Tilemap terrain, int index, Vector2Int sector)
        {
            if (data.art == null)
            {
                return;
            }

            //get roof coords
            Vector3Int position = new Vector3Int(index % sectorDimsRoofs, 0, 0);
            position.y = (index - position.x) / sectorDimsRoofs;
            position.x = -position.x * roofTileDims;
            position.y = -position.y * roofTileDims;

            TileBase tile = Resources.Load<Tile>("Tiles/Roofs/" + data.art + data.ID); //get sprite
            if (tile == null)
            {
                Debug.Log("Invalid roof tile: " + data.art + data.ID);
            }

            if (_instance == null) //prevents bugs if the game stops running while a sector file is being read
            {
                return;
            }

            roofs.SetTile(position, tile); //create roof tile
            roofs.SetTileFlags(position, TileFlags.None); //clear flags so the tile can be tinted or made transparent

            Walls connectedRoofs = GetConnectedRoofs(data.ID);

            if (data.flipped) //flip
            {
                roofs.SetTransformMatrix(position, Matrix4x4.Scale(new Vector3(-1f, 1f, 1f)));
                roofs.SetColor(position, colSE); //tint flipped
                connectedRoofs = FlipWallValues(connectedRoofs);
            }

            //add connected roofs to tile data
            dataFromTiles[SectorToGlobalPosition((Vector2Int)position, sector)].SetRoof(connectedRoofs);

            //create shadow
            bool[,] shadow = GameData.ObjArt.GetRoofShadow(data.ID);
            position.x -= roofTileDims - 1;

            for (int tileY = 0; tileY < roofTileDims; tileY++) //tint floor
            {
                for (int tileX = 0; tileX < roofTileDims; tileX++)
                {
                    if (((!data.flipped) && (shadow[tileY, tileX])) || ((data.flipped) && (shadow[3 - tileX, 3 - tileY]))) //check if this tile needs a shadow
                    {
                        terrain.SetColor(position, Graphics.ColorManager.indoor);
                        dataFromTiles[SectorToGlobalPosition((Vector2Int)position, sector)].isIndoors = true;
                    }
                    position.x++;
                }
                position.x -= roofTileDims;
                position.y--;
            }
        }

        private GameObject CreateObject(Objects.NewObjectData data, Vector2Int sector, string type)
        {
            if (_instance == null) // Prevents bugs if the game stops running while a sector file is being read
            {
                return null;
            }

            GameObject prefab = null; //get prefab
            Transform parent = null; //get parent object
            if (data.type == Objects.Types.wall) //wall
            {
                prefab = wallPrefab;
                parent = wallParent;
            }
            else if (data.type == Objects.Types.portal) //portal
            {
                prefab = portalPrefab;
                parent = portalParent;
            }

            else if (data.type == Objects.Types.scenery) //scenery
            {
                prefab = sceneryPrefab;
                parent = sceneryParent;
            }

            GameObject objInstance = Instantiate(prefab, parent); //instantiate object
            SpriteRenderer objRenderer = objInstance.GetComponent<SpriteRenderer>();

            bool isPortal = false;
            if (data.type == Objects.Types.wall) //walls
            {
                char checkID = data.art[3];
                if ((checkID == 'd') || (checkID == 'w')) //check if door or window
                {
                    checkID = data.art[5];
                    isPortal = ((checkID != 'l') && (checkID != 'r')); //check if middle tile (i.e. 'a', 'b', 'c', or 'd')
                }
            }
            else if (data.type == Objects.Types.portal) //portals
            {
                isPortal = true;
                dataFromTiles[data.position].portalObjects.Add(data.side, objInstance); //add to tile's wall dictionary
            }

            if (dataFromTiles[data.position].isIndoors) //check if there's a roof above the object
            {
                data.roofShadow = true;
            }

            if (data.flipped) //flip the object horizontally if needed
            {
                objRenderer.flipX = true;
            }

            Vector3 transformOffset = new Vector3();
            if (data.type == Objects.Types.wall || data.type == Objects.Types.portal) //only apply tinting & position offset to walls and portals
            {
                if (data.side == Walls.northEast) //northeast
                {
                    if (data.roofShadow)
                    {
                        objRenderer.color = colNE;
                    }
                    transformOffset = wallOffsetNortheast;
                    if (!isPortal)
                    {
                        dataFromTiles[new Vector2Int(data.position.x, data.position.y)].SetWall(Walls.northEast, true);
                        dataFromTiles[new Vector2Int(data.position.x + 1, data.position.y)].SetWall(Walls.southWest, true);
                    }
                }
                else if (data.side == Walls.southEast) //southeast
                {
                    objRenderer.color = colSE; //always tinted
                    transformOffset = wallOffsetSouthheast;
                    if (!isPortal)
                    {
                        dataFromTiles[new Vector2Int(data.position.x, data.position.y)].SetWall(Walls.southEast, true);
                        dataFromTiles[new Vector2Int(data.position.x, data.position.y - 1)].SetWall(Walls.northWest, true);
                    }
                }
                else if (data.side == Walls.southWest) //southwest
                {
                    if (!isPortal)
                    {
                        dataFromTiles[new Vector2Int(data.position.x, data.position.y)].SetWall(Walls.southWest, true);
                        dataFromTiles[new Vector2Int(data.position.x - 1, data.position.y)].SetWall(Walls.northEast, true);
                    }
                }
                else if (data.side == Walls.northWest) //northwest
                {
                    if (data.roofShadow)
                    {
                        objRenderer.color = colNW;
                    }
                    else
                    {
                        objRenderer.color = colSE;
                    }
                    transformOffset = wallOffsetNorthwest;
                    if (!isPortal)
                    {
                        dataFromTiles[new Vector2Int(data.position.x, data.position.y)].SetWall(Walls.northWest, true);
                        dataFromTiles[new Vector2Int(data.position.x, data.position.y + 1)].SetWall(Walls.southEast, true);
                    }
                }
            }
            else if (data.roofShadow) //apply tinting to non-wall objects
            {
                objRenderer.color = Graphics.ColorManager.indoor;
            }

            //set object position
            GlobalScript.Global.PixelPerfectPosition(objInstance.transform, grid.GetCellCenterWorld(new Vector3Int(data.position.x, data.position.y, 0)) + transformOffset + data.positionOffset);

            if (data.type == Objects.Types.portal) //make sure portals are rendered in front of walls
            {
                objInstance.transform.position = new Vector3(objInstance.transform.position.x - 0.002f, objInstance.transform.position.y - 0.002f, 0);
            }

            if (objectIndex.ContainsKey(sector)) //add to the list of objects within the sector
            {
                objectIndex[sector].Add(objInstance);
            }
            else //create new key if the sector isn't in the dictionary
            {
                List<GameObject> newList = new List<GameObject>();
                newList.Add(objInstance);
                objectIndex.Add(sector, newList);
            }

            return objInstance;
        }

        public void LoadSectorsAtRadius(Vector2Int location)
        {
            LoadSector(location.x, location.y);

            for (int x = -renderDistance + location.x; x <= renderDistance + location.x; x++)
            {
                for (int y = -renderDistance + location.y; y <= renderDistance + location.y; y++)
                {
                    LoadSector(x, y);
                }
            }
        }

        public async void LoadSector(int sectorX, int sectorY, bool blockingScript = false)
        {
            Vector2Int sector = new Vector2Int(sectorX, sectorY);

            if (loadedSectors.ContainsKey(sector) || toLoadSectors.Contains(sector)) //check if the sector is already loaded
            {
                return;
            }

            if (sectorX > 0 || sectorY > 0)
            {
                Debug.Log("Invalid sector position: " + sector);
                return;
            }
            toLoadSectors.Add(sector);

            GameObject sectorInstance = Instantiate(sectorPrefab, sectorParent); //instantiate sector object
            Tilemap sectorTilemap = sectorInstance.GetComponent<Tilemap>();
            sectorInstance.name = "sector " + sector;
            Global.PixelPerfectPosition(sectorInstance.transform, new Vector3((sectorX - sectorY) * sectorDimsWorld.x * 0.5f, (sectorX + sectorY) * sectorDimsWorld.y * 0.5f, 0));
            
            long sectorID = GetSectorID(sectorX, sectorY);
            string path = "Assets/Resources/Modules/" + GameOptions.module + "/MapSectors/" + PlayerVars.currentLocation + "/" + sectorID + ".txt";

            bool isTerrainSector = false;
            if (!File.Exists(path) && (PlayerVars.currentLocation == "Arcanum1-024-fixed"))
            {
                path = GetTerrainSector(sectorX, sectorY); //not a custom sector
                isTerrainSector = true;
            }

            byte[] data;

            using (FileStream fstream = File.OpenRead(path))
            {
                data = new byte[fstream.Length];

                if (blockingScript) //run on the main thread
                {
                    fstream.Read(data, 0, Convert.ToInt32(fstream.Length));
                }
                else //run asynchronously
                {
                    await Task.Run(() =>
                    {
                        fstream.Read(data, 0, Convert.ToInt32(fstream.Length));
                        return data;
                    });
                }
            }

            if (_instance == null) //prevents bugs if the game stops running while a sector file is being read
            {
                return;
            }

            int dataID = 4; //skip header
            dataID += data[0] * 48; //skip the initial unreversed section (lights)

            NewTileData[] output = new NewTileData[tilesTotal];
            int remainder;
            int incrementType;
            int incrementID;

            for (int i = 0; i < tilesTotal; i++, dataID += 4)
            {
                output[i] = new NewTileData();
                remainder = 0;
                incrementType = 0;
                incrementID = 0;

                if (data[dataID + 3] >= 176) //FACADES
                {
                    //READ BLOCKED:
                    if (data[dataID] % 2 == 0)
                    {
                        output[i].blocked = true;
                    }

                    //READ ID:
                    incrementID = data[dataID + 1] % 8;
                    incrementID = incrementID * 128;
                    output[i].ID = Mathf.RoundToInt(Mathf.Floor(data[dataID] / 2)) + incrementID;

                    //READ TILESET:
                    if (data[dataID + 3] == 190) //maybe you can integrate this into the formula below but idk how
                    {
                        incrementType = 256;
                    }
                    else
                    {
                        incrementType = (data[dataID + 3] % 2) * 128;
                    }
                    output[i].list = "facades";
                    output[i].type = Tiles.TilesetNames.facades[data[dataID + 2] / 2 + Mathf.Abs(incrementType)];
                    continue;
                }

                if (data[dataID] == 0) //READ UNFLIPPABLE
                {
                    if (data[dataID + 1] % 2 == 0) //even number: indoor unflippable
                    {
                        output[i].list = "inUnflip";
                        output[i].type = Tiles.TilesetNames.inUnflipFlags[data[dataID + 2] % 64].name;
                    }
                    else //odd number: outdoor unflippable
                    {
                        output[i].list = "outUnflip";
                        output[i].type = Tiles.TilesetNames.outUnflipFlags[data[dataID + 2] % 64].name;
                    }
                }
                else if (data[dataID] == 128) //idk what the point of this particular hack is or how it worked originally but it's used for dock graphics and SnwICE
                {
                    output[i].list = "subtypes";
                    switch (data[dataID + 2])
                    {
                        case 1:
                            output[i].type = Tiles.TilesetNames.subtypes[29];
                            break;
                        case 2:
                            output[i].type = Tiles.TilesetNames.subtypes[30];
                            break;
                        case 3:
                            output[i].type = Tiles.TilesetNames.subtypes[31];
                            break;
                        case 197:
                            output[i].type = Tiles.TilesetNames.subtypes[35];
                            break;
                        default:
                            Debug.Log("[!!!] Expand the subtype exception list for: " + data[dataID + 2]);
                            break;
                    }
                }
                else //READ FLIPPABLE
                {
                    //READ FLIPPED:
                    output[i].flipped = data[dataID] == 193; //check if tile is flipped

                    //READ TILESET:
                    if (data[dataID + 1] % 2 == 0) //even number: indoor flippable tiles
                    {
                        output[i].list = "inFlip";
                        output[i].type = Tiles.TilesetNames.inFlippable[data[dataID + 2] % 64];
                    }
                    else //odd number: outdoor flippable
                    {
                        int tilesetID = GlobalScript.Global.BytesToInt(data[dataID + 2], data[dataID + 3]);
                        remainder = tilesetID % 65;

                        if (remainder == 0) //no remainder, tileset is "bse" type
                        {
                            output[i].list = "outFlip";
                            output[i].type = Tiles.TilesetNames.outFlipFlags[tilesetID / 65].name;
                        }
                        else if (remainder < Tiles.TilesetNames.subtypes.Count()) //remainder, tileset is subtype
                        {
                            output[i].list = "subtypes";
                            output[i].type = Tiles.TilesetNames.subtypes[tilesetID % 64 - 1];
                        }
                        else //DEBUG
                        {
                            output[i] = InvalidTile(output[i].blocked);
                            continue;
                        }
                    }
                }

                output[i].ID = (Tiles.TilesetNames.setNum[(data[dataID + 1] - 1) / 16] * 8) + Mathf.CeilToInt(((data[dataID + 1] - 1) % 16) / 2); //convert to new ID
            }

            int tileIndex;
            for (int y = 0; y < sectorDimsTiles; y++) //create tiles
            {
                for (int x = 0; x < sectorDimsTiles; x++)
                {
                    tileIndex = sectorDimsTiles * y + x;
                    output[tileIndex].position = new Vector2Int(-x, -y);
                    output[tileIndex].globalPosition = new Vector2Int(-x + (sectorDimsTiles * sectorX), -y + (sectorDimsTiles * sectorY));
                    CreateTile(output[tileIndex], sectorInstance.GetComponent<Tilemap>());
                }
            }


            //ROOF DATA
            dataID += 4; //offset roof header

            if (data[dataID - 4] == 0) //roof data is present
            {
                NewRoofData[] roofOutput = new NewRoofData[roofsTotal];
                GameObject roofsInstance = Instantiate(roofsPrefab, roofParent); //instantiate roof sector object
                Tilemap roofTilemap = roofsInstance.GetComponent<Tilemap>();
                roofTilemaps.Add(sector, roofTilemap);
                roofsInstance.name = "roofs " + sector;
                roofsInstance.transform.position = sectorInstance.transform.position;

                for (int i = 0; i < 256; i++, dataID += 4)
                {
                    roofOutput[i] = new NewRoofData();

                    if (data[dataID] == 255) //no roof tile at these coords
                    {
                        continue;
                    }

                    if (data[dataID] == 17) //flipped
                    {
                        roofOutput[i].flipped = true;
                    }

                    //get roof sprite name
                    roofOutput[i].art = Tiles.TilesetNames.roofs[Mathf.FloorToInt(data[dataID + 2] / 8)] + "_";
                    roofOutput[i].ID = data[dataID + 1] / 64 + (data[dataID + 2] % 8) * 4; //sprite ID

                    CreateRoof(roofOutput[i], roofTilemap, sectorTilemap, i, sector);
                }
            }


            //SKIP UNREVERSED SCRIPT DATA
            byte header = data[dataID];
            dataID += 4; //offset unreversed header
            if (header != 0)
            {
                dataID += 4 + data[dataID] * 24; //offset scripts header & body
                if (header != 1) //offset unreversed section
                {
                    dataID += 32;
                }
            }


            //PASSABILITY DATA
            if ((data[dataID] != 119) && (dataID + 4 != data.Length))
            {
                dataID += 4; //offset passability header

                if (data[dataID - 4] != 0) //passability data
                {
                    for (int b = 0; b < tilesTotal / 8; b++, dataID++) //read blocked tiles
                    {
                        for (int i = 0; i < 8; i++)
                        {
                            if ((data[dataID] & (1 << i)) != 0) //read individual bits
                            {
                                TileOperations.SetBlocked(ref dataFromTiles[output[b * 8 + i].globalPosition].flags, true); //pass blocking flag to tile data
                            }
                        }
                    }
                }
                else if ((data[dataID] != 119) && (dataID + 4 != data.Length)) //skip empty passability section (rarely found in some .sec files)
                {
                    dataID += 512;
                }
            }


            //OBJECT DATA
            int objNum = GlobalScript.Global.BytesToInt(data[data.Length - 4], data[data.Length - 3]);
            if (objNum > 0)
            {
                Objects.NewObjectData objData = null;
                Objects.PortalData portalData = null;
                Objects.SceneryData sceneryData = null;
                GameObject newObject = null;
                SpriteRenderer objRenderer;
                int pointer;
                byte storedByte;

                int protoID;
                int artNameValue;
                int tileVariation;
                string[] tileset;

                for (int i = 0; i < objNum; i++)
                {
                    if (data[dataID] != 119) Debug.Log("Invalid object data at: " + path + ", " + dataID + "; object ID: " + i);

                    objData = new Objects.NewObjectData();
                    objRenderer = null;

                    //get object type & prototype
                    protoID = GlobalScript.Global.BytesToInt(data[dataID + 12], data[dataID + 13]);
                    objData.type = (Objects.Types)data[dataID + 52];

                    if (objData.type == Objects.Types.portal)
                    {
                        portalData = new Objects.PortalData();
                    }
                    else if (objData.type == Objects.Types.scenery)
                    {
                        sceneryData = new Objects.SceneryData();
                    }

                    //start of get object data
                    pointer = dataID + 70;

                    if ((data[dataID + 58] & 1) == 1) //custom art ID
                    {
                        GetObjectArtName(ref data, pointer, ref objData);
                        pointer += 4;
                    }

                    objData.position.x = -GlobalScript.Global.BytesToInt(ref data, pointer + 1, true); //get X
                    objData.position.y = -GlobalScript.Global.BytesToInt(ref data, pointer + 5, true); //get Y
                    if (isTerrainSector) //offset coords for objects within generic terrain sectors
                    {
                        objData.position = FixTerrainCoords(objData.position, sectorX, sectorY);
                    }
                    pointer += 9;
                    if ((data[dataID + 58] & 4) == 4) //X offset
                    {
                        objData.positionOffset.x = GetPositionOffset(ref data, pointer, true);
                        pointer += 4;
                    }
                    if ((data[dataID + 58] & 8) == 8) //Y offset
                    {
                        objData.positionOffset.y = GetPositionOffset(ref data, pointer, false);
                        pointer += 4;
                    }

                    if ((data[dataID + 59] & 1) == 1) //blending
                    {
                        objData.blendingMode = (Graphics.BlendingMode)data[pointer];
                        pointer += 4;
                    }

                    if ((data[dataID + 59] & 16) == 16) //light flags
                    {
                        //UNFINISHED
                        pointer += 4;
                    }

                    if ((data[dataID + 59] & 32) == 32) //light art
                    {
                        //UNFINISHED
                        pointer += 4;
                    }

                    if ((data[dataID + 59] & 64) == 64) //light color
                    {
                        //UNFINISHED
                        pointer += 4;
                    }

                    if ((data[dataID + 60] & 4) == 4) //proto flags
                    {
                        objData.flags = (Objects.ObjectFlags)GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        objData.containsFlags = true;
                        pointer += 4;
                    }

                    if ((data[dataID + 60] & 8) == 8) //additional proto flags
                    {
                        objData.extraFlags = (Objects.ExtraFlags)GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        objData.containsExtraFlags = true;
                        pointer += 4;
                    }

                    if ((data[dataID + 60] & 32) == 32) //internal ID
                    {
                        objData.internalID = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        pointer += 4;
                    }

                    if ((data[dataID + 60] & 64) == 64) //known description
                    {
                        objData.known = Objects.ObjData.descriptions[GlobalScript.Global.BytesToInt(ref data, pointer, true)];
                        pointer += 4;
                    }

                    if ((data[dataID + 60] & 128) == 128) //custom art ID (repeated for some reason)
                    {
                        GetObjectArtName(ref data, pointer, ref objData);
                        pointer += 4;
                    }

                    if ((data[dataID + 61] & 1) == 1) //additional art
                    {
                        //UNFINISHED
                        pointer += 4;
                    }

                    if ((data[dataID + 61] & 2) == 2) //armor class
                    {
                        objData.armorClass = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        objData.containsArmorClass = true;
                        pointer += 4;
                    }

                    if ((data[dataID + 61] & 4) == 4) //points spent
                    {
                        objData.hitPoints.pointsSpent = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        objData.containsPointsSpent = true;
                        pointer += 4;
                    }

                    if ((data[dataID + 61] & 8) == 8) //adjustment
                    {
                        objData.hitPoints.adjustment = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        objData.containsAdjustment = true;
                        pointer += 4;
                    }

                    if ((data[dataID + 61] & 16) == 16) //damage taken
                    {
                        objData.hitPoints.damageTaken = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        objData.containsDamageTaken = true;
                        pointer += 4;
                    }

                    if ((data[dataID + 61] & 64) == 64) //resistances
                    {
                        pointer = Prototypes.ProtoManager.GetResistanceData(ref objData.resistances, ref data, pointer);
                    }

                    if ((data[dataID + 61] & 128) == 128) //scripts
                    {
                        if (GlobalScript.Global.BytesToInt(ref data, pointer, true) != 3073) //check script header
                        {
                            Debug.Log("Error finding script data at: " + path + ", " + dataID + ", " + pointer);
                            continue;
                        }
                        pointer += 5; //offset header
                        storedByte = data[pointer]; //get number of scripts
                        pointer += 12; //offset number of scripts
                        //UNFINISHED
                        pointer += 12 * storedByte; //offset script data
                        //UNFINISHED
                        pointer += 8; //offset used scripts
                    }

                    if ((data[dataID + 62] & 1) == 1) //sound
                    {
                        objData.soundEffect = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        pointer += 4;
                    }

                    if ((data[dataID + 66] & 1) == 1) //type-specific flags
                    {
                        objData.flags3 = (Objects.ObjFlags)GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        pointer += 4;
                    }

                    if ((data[dataID + 66] & 2) == 2) //lock/trap difficulty
                    {
                        objData.difficulty = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        pointer += 4;
                    }

                    if ((data[dataID + 66] & 4) == 4) //keyID | respawn delay
                    {
                        if (objData.type == Objects.Types.portal) //keyID
                        {
                            objData.keyID = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        }
                        else //respawn delay
                        {
                            objData.respawnDelay = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        }
                        pointer += 4;
                    }

                    if ((data[dataID + 66] & 8) == 8) //notify NPC
                    {
                        objData.notifyNPC = GlobalScript.Global.BytesToInt(ref data, pointer, true);
                        pointer += 4;
                    }
                    //end of get object data

                    //type-specific operations
                    if (objData.type == Objects.Types.wall) //walls
                    {
                        //get wall placement
                        objData.side = IntToWallSide(Mathf.FloorToInt(data[dataID + 71] / 16) % 4);
                        if (objData.side == Walls.northEast || objData.side == Walls.northWest) //northeast & northwest
                        {
                            tileset = GameData.ObjArt.intTypes; //interior
                        }
                        else //southeast & southwest
                        {
                            tileset = GameData.ObjArt.extTypes; //exterior
                        }

                        //get art name
                        objData.art = tileset[Mathf.FloorToInt(data[dataID + 72] / 16) + (data[dataID + 73] - 16) * 16]; //get set name

                        artNameValue = Mathf.FloorToInt(data[dataID + 71] / 64) + (data[dataID + 72] % 16) * 4; //get tile name ID
                        tileVariation = data[dataID + 71] % 8; //get 5th character (tile variation ID)

                        if (artNameValue >= GameData.ObjArt.wallNames.Count()) //invalid name value
                        {
                            Debug.Log("Couldn't find wall ID for: wall set " + objData.art + ", value " + artNameValue);
                            objData.art += "???";
                        }
                        else
                        {
                            objData.art += GameData.ObjArt.wallNames[artNameValue]; //get wall name
                        }

                        if ((tileVariation == 4) && (data[dataID + 72] % 16 == 2)) //right tile
                        {
                            objData.art += "r";
                            tileVariation = 0;
                        }
                        else if ((tileVariation == 4) || (data[dataID + 70] >= 128)) //left tile
                        {
                            objData.art += "l";
                            if (objData.art == "shkw3rl") Debug.Log(data[dataID + 70] + ", " + data[dataID + 71] + ", " + data[dataID + 72]);
                            tileVariation = 0;
                        }
                        else //universal tile
                        {
                            objData.art += "u";
                        }

                        objData.art += tileVariation; //add tile variation ID

                        //get other data
                        objData.flipped = (data[dataID + 70] % 128 == 17);
                        objData.blendingMode = Graphics.BlendingMode.alpha;

                        newObject = CreateObject(objData, sector, "wall");
                        Prototypes.ProtoManager.ImportWallData(newObject, objData);
                        objRenderer = newObject.GetComponent<SpriteRenderer>();
                    }
                    else if (objData.type == Objects.Types.portal) //portals (doors & windows)
                    {
                        if (protoID <= 2034)
                        {
                            tileset = GameData.ObjArt.doorNames; //doors
                        }
                        else
                        {
                            tileset = GameData.ObjArt.windowNames; //windows
                        }

                        //get portal placement
                        objData.side = IntToWallSide(Mathf.FloorToInt(data[dataID + 71] / 16) % 4);

                        //get art name
                        objData.art = tileset[Mathf.FloorToInt(data[dataID + 72] / 8) + (data[dataID + 73] - 48) * 32];


                        //get other data
                        objData.flipped = (data[dataID + 70] % 128 == 17);

                        newObject = CreateObject(objData, sector, "portal");
                        portalData = Prototypes.ProtoManager.ImportPortalData(newObject, objData, protoID);
                        objRenderer = newObject.GetComponent<SpriteRenderer>();
                    }
                    else if (objData.type == Objects.Types.scenery) //scenery
                    {
                        newObject = CreateObject(objData, sector, "scenery");
                        sceneryData = Prototypes.ProtoManager.ImportSceneryData(newObject, objData, protoID);
                        objRenderer = newObject.GetComponent<SpriteRenderer>();
                        newObject.transform.name = sceneryData.known;

                        if (sceneryData.GetObjFlag(Objects.ObjectFlags.clickThrough)) //click-through object
                        {
                            newObject.layer = Movement.MouseController.Instance.ignoreRaycastLayer;
                        }

                        if (!sceneryData.GetObjFlag(Objects.ObjectFlags.noBlock)) //blocks tile //UNFINISHED: also check for containers
                        {
                            TileOperations.SetBlocked(ref dataFromTiles[objData.position].flags, true);
                        }

                        if (sceneryData.GetSceneryFlag(Objects.SceneryFlags.nocturnal)) //nocturnal, only visible at night
                        {
                            GlobalScript.TimeManager.nocturnalObjects.Add(newObject);
                            if (!GlobalScript.TimeManager.isNight)
                            {
                                objRenderer.enabled = false;
                            }
                        }
                    }

                    if (objData.type == Objects.Types.portal || objData.type == Objects.Types.container)
                    {
                        Objects.LockManager.ProcessLockFlags(portalData, newObject, true);
                    }

                    if (objRenderer != null) //set object graphic
                    {
                        if (objData.GetObjFlag(Objects.ObjectFlags.flat)) //flat object
                        {
                            objRenderer.sortingLayerName = GlobalScript.Global.flatObjLayer;
                        }

                        if (objData.type == Objects.Types.scenery && !sceneryData.GetSceneryFlag(Objects.SceneryFlags.noAutoAnimate)) //load full animation
                        {
                            Graphics.SpriteManager.GetSprite(ref objData, objRenderer, true, false, false, sector);
                        }
                        else //load one sprite only
                        {
                            Graphics.SpriteManager.GetSprite(ref objData, objRenderer);
                        }

                        if (objData.type != Objects.Types.scenery || !sceneryData.GetObjFlag(Objects.ObjectFlags.clickThrough)) //set collider for clickable objects
                        {
                            Objects.ObjectOperations.UpdateCollider(newObject, objRenderer);
                        }
                        ApplyBlending(objRenderer, objData);
                    }

                    dataID = pointer; //offset to next object
                }
            }


            //FINISHING TOUCHES
            if (dataID != data.Length - 4)
            {
                Debug.Log("Didn't reach the end of the sector file at: " + path
                    + "; currently at:" + dataID + " while file length is " + (data.Length - 4));
            }

            if (loadedSectors.Count() > maxSectors) //unload sectors if too many are loaded
            {
                FindSectorsToUnload();
            }

            loadedSectors.Add(sector, sectorTilemap); //make sure you add the sector to the list AFTER unloading extra sectors to prevent it from unloading when teleporting

            if (toLoadSectors.Contains(sector)) //this check is here in case of conflicts with other scripts
            {
                toLoadSectors.Remove(sector);
            }
        }

        private static void FindSectorsToUnload()
        {
            List<Vector2Int> unloadSectors = loadedSectors.Keys.ToList();

            for (int x = -renderDistance + PlayerVars.currentSector.x; x <= renderDistance + PlayerVars.currentSector.x; x++) //keep sectors surrounding player
            {
                for (int y = -renderDistance + PlayerVars.currentSector.y; y <= renderDistance + PlayerVars.currentSector.y; y++)
                {
                    if (unloadSectors.Contains(new Vector2Int(x, y)))
                    {
                        unloadSectors.Remove(new Vector2Int(x, y));
                    }
                }
            }

            Vector2Int mouseSector = Movement.MouseController.GetSectorAtMouse();

            for (int x = -renderDistance + mouseSector.x; x <= renderDistance + mouseSector.x; x++) //keep sectors surrounding camera
            {
                for (int y = -renderDistance + mouseSector.y; y <= renderDistance + mouseSector.y; y++)
                {
                    if (unloadSectors.Contains(new Vector2Int(x, y)))
                    {
                        unloadSectors.Remove(new Vector2Int(x, y));
                    }
                }
            }

            foreach (Vector2Int sector in PathFinder.pathSectors) //keep sectors on player's path loaded
            {
                if (unloadSectors.Contains(sector))
                {
                    unloadSectors.Remove(sector);
                }
            }

            while ((loadedSectors.Count() - unloadSectors.Count() < maxSectors) && (unloadSectors.Count() > 0)) //don't unload too many sectors
            {
                unloadSectors.Remove(unloadSectors.Last()); //don't unload the newest loaded sector
            }

            foreach (Vector2Int sector in unloadSectors) //unload sectors
            {
                UnloadSector(sector.x, sector.y);
            }
        }

        private static void UnloadSector(int sectorX, int sectorY)
        {
            Vector2Int sectorToUnload = new Vector2Int(sectorX, sectorY);

            if ((!loadedSectors.ContainsKey(sectorToUnload)) || (PlayerVars.currentSector == sectorToUnload)) //check if the sector is loaded and if player is standing at the sector
            {
                return;
            }

            Destroy(loadedSectors[sectorToUnload].gameObject); //delete sector tilemap
            loadedSectors.Remove(sectorToUnload);

            if (roofTilemaps.ContainsKey(sectorToUnload)) //delete roofs
            {
                Destroy(roofTilemaps[sectorToUnload].gameObject);
                roofTilemaps.Remove(sectorToUnload);
            }

            Vector2Int currentTile;
            for (int y = 0; y < sectorDimsTiles; y++) //delete tile data
            {
                for (int x = 0; x < sectorDimsTiles; x++)
                {
                    currentTile = new Vector2Int(-x + (sectorDimsTiles * sectorX), -y + (sectorDimsTiles * sectorY));

                    if (dataFromTiles.ContainsKey(currentTile)) //this check is a bug fix in case the tile got unloaded earlier (e.g. by another call of the same script
                    {
                        dataFromTiles.Remove(currentTile);
                    }
                }
            }

            if (objectIndex.ContainsKey(sectorToUnload)) //delete objects
            {
                if (Graphics.SpriteManager.animatedObjects.ContainsKey(sectorToUnload)) //remove animated objs from list
                {
                    Graphics.SpriteManager.animatedObjects.Remove(sectorToUnload);
                }

                for (int i = 0; i < objectIndex[sectorToUnload].Count; i++)
                {
                    if (GlobalScript.TimeManager.nocturnalObjects.Contains(objectIndex[sectorToUnload][i])) //remove nocturnal objs from list
                    {
                        GlobalScript.TimeManager.nocturnalObjects.Remove(objectIndex[sectorToUnload][i]);
                    }

                    if (GlobalScript.TimeManager.timedLocks.ContainsKey(objectIndex[sectorToUnload][i])) //remove lockedDay and lockedNight objects
                    {
                        GlobalScript.TimeManager.timedLocks.Remove(objectIndex[sectorToUnload][i]);
                    }

                    Destroy(objectIndex[sectorToUnload][i]); //delete object instance
                }
                objectIndex.Remove(sectorToUnload); //remove from obj list
            }

            loadedSectors.Remove(sectorToUnload);
        }

        private static long GetSectorID(long x, long y)
        {
            long sectorID = -x + (-y * 67108864);
            return sectorID;
        }

        private static void GetGlobalMapDimensions()
        {
            using (FileStream fstream = File.OpenRead("Assets/Resources/Modules/" + GameOptions.module + "/terrain.txt"))
            {
                fstream.Seek(8, SeekOrigin.Begin); //skip file header
                fstream.Read(globalMapData, 0, 8);
                worldWidth = BitConverter.ToInt32(globalMapData, 0); //get world width
                fstream.Read(globalMapData, 0, 8);
                worldHeight = BitConverter.ToInt32(globalMapData, 0); //get world height
            }
        }

        private static string GetTerrainSector(int x, int y)
        {
            x *= -1;
            y *= -1;
            byte[] rowDataZlib;

            using (FileStream fstream = File.OpenRead("Assets/Resources/Modules/" + GameOptions.module + "/terrain.txt"))
            {
                fstream.Seek(32, SeekOrigin.Begin); //skip file header

                byte[] rowLength = new byte[4];
                int rowLengthInt;

                for (int i = 0; i < y; i++) //skip to the right row
                {
                    fstream.Read(rowLength, 0, 4);
                    rowLengthInt = BitConverter.ToInt32(rowLength, 0);
                    fstream.Seek(rowLengthInt, SeekOrigin.Current);
                }

                fstream.Read(rowLength, 0, 4);
                rowLengthInt = BitConverter.ToInt32(rowLength, 0);
                rowDataZlib = new byte[rowLengthInt];
                fstream.Read(rowDataZlib, 0, rowLengthInt); //read row data in zlib
            }

            byte[] rowData = new byte[worldWidth * 2];
            rowData = GlobalScript.Global.DecompressZlibData(rowDataZlib); //decompress row data

            byte sectorTerrain = rowData[x * 2 + 1];
            int sectorID = rowData[x * 2] + (sectorTerrain % 8) * 256;

            string terrain = GameData.TerrainTypes.terrain[sectorTerrain / 8].name;
            string terrain2 = GameData.TerrainTypes.terrain[Mathf.RoundToInt(Mathf.Floor(sectorID / 64))].name;
            string path;

            if ((sectorID % 64 < 4) || (terrain == terrain2)) //base sector
            {
                sectorID = sectorID % 64;
                switch (sectorID) //get file name
                {
                    case 0:
                        sectorID = 0;
                        break;
                    case 1:
                        sectorID = 1;
                        break;
                    case 2:
                        sectorID = 67108864;
                        break;
                    case 3:
                        sectorID = 67108865;
                        break;
                }
                path = "Assets/Resources/Terrain/" + terrain + "/" + sectorID + ".txt";
            }
            else //edge sector
            {
                bool reverseFolder = false;
                sectorID = (sectorID % 64) / 4;

                switch (sectorID) //get file name
                {
                    case 1:
                        sectorID = 1; //bottom left
                        break;
                    case 2:
                        sectorID = 134217729; //top left
                        break;
                    case 3:
                        sectorID = 67108865; //left
                        break;
                    case 4:
                        sectorID = 134217731; //top right
                        break;
                    case 5:
                        sectorID = 0; //diagonal
                        break;
                    case 6:
                        sectorID = 134217730; //top
                        break;
                    case 7:
                        sectorID = 3; //bottom right (reversed)
                        reverseFolder = true;
                        break;
                    case 8:
                        sectorID = 3; //bottom right
                        break;
                    case 9:
                        sectorID = 2; //bottom
                        break;
                    //case 10
                    case 11:
                        sectorID = 134217731; //top right (reversed)
                        reverseFolder = true;
                        break;
                    case 12:
                        sectorID = 67108867; //right
                        break;
                    case 13:
                        sectorID = 134217729; //top left (reversed)
                        reverseFolder = true;
                        break;
                    case 14:
                        sectorID = 1; //bottom left (reversed)
                        reverseFolder = true;
                        break;
                    default: //debug
                        sectorID = 67108864;
                        break;
                }

                path = "Assets/Resources/Terrain/" + terrain + " to " + terrain2 + "/" + sectorID + ".txt";

                if (!File.Exists(path) || reverseFolder) //check if terrain 1 connects to terrain 2 or the other way around
                {
                    path = "Assets/Resources/Terrain/" + terrain2 + " to " + terrain + "/" + sectorID + ".txt";
                }
            }

            return path;
        }

        public void RevealBlockedTiles() //make all blocked tiles red (debug feature)
        {
            foreach (Vector2Int tile in dataFromTiles.Keys)
            {
                if ((dataFromTiles[tile].IsBlocked) || (dataFromTiles[tile].IsBlockedFlyable))
                {
                    loadedSectors[GlobalPositionToSector(tile)].SetColor((Vector3Int)GlobalToSectorPosition(tile), Color.red);
                }
            }
        }

        public static void TeleportPlayer(Vector2Int coords)
        {
            if (PlayerVars.isMoving)
            {
                Movement.MouseController.Instance.StopMoving();
            }

            if (coords.x > 0 || coords.y > 0) //fix wrong sign
            {
                coords *= -1;
            }

            Vector2Int sector = GlobalPositionToSector(coords); //get sector coords
            Instance.LoadSector(sector.x, sector.y, true);
            Movement.MouseController.Instance.PositionCharacterOnTile(coords);
            CameraMovement.Instance.FocusCameraOnPlayer();
        }

        private static Vector2Int FixTerrainCoords(Vector2Int position, int sectorX, int sectorY) //converts coord data found in terrain .sec files
        {
            position.x = position.x % sectorDimsTiles + sectorX * sectorDimsTiles;
            position.y = position.y % sectorDimsTiles + sectorY * sectorDimsTiles;
            return position;
        }

        private static Walls GetConnectedRoofs(int ID) //gets roofs connected to a roof tile
        {
            Walls connected = Walls.none;

            switch (ID)
            {
                case 0:
                    connected = Walls.northEast | Walls.southEast;
                    break;
                case 1:
                    connected = Walls.northEast | Walls.southEast | Walls.northWest;
                    break;
                case 2:
                    connected = Walls.northEast | Walls.southEast | Walls.southWest;
                    break;
                case 4:
                    connected = Walls.northEast | Walls.northWest;
                    break;
                case 7:
                    connected = Walls.southEast | Walls.southWest;
                    break;
                default:
                    connected = Walls.northEast | Walls.southEast | Walls.southWest | Walls.northWest; //used for '3', '5', '6', '8'
                    break;
            }
            return connected;
        }

        private static Walls FlipWallValues(Walls oldWalls) //flips Walls values horizontally
        {
            Walls flipped = Walls.none;

            if (oldWalls.HasFlag(Walls.north)) flipped |= Walls.north;
            if (oldWalls.HasFlag(Walls.northEast)) flipped |= Walls.northWest;
            if (oldWalls.HasFlag(Walls.east)) flipped |= Walls.west;
            if (oldWalls.HasFlag(Walls.southEast)) flipped |= Walls.southWest;
            if (oldWalls.HasFlag(Walls.south)) flipped |= Walls.south;
            if (oldWalls.HasFlag(Walls.southWest)) flipped |= Walls.southEast;
            if (oldWalls.HasFlag(Walls.west)) flipped |= Walls.east;
            if (oldWalls.HasFlag(Walls.northWest)) flipped |= Walls.northEast;

            return flipped;
        }

        public static void ToggleRoofVisibility(Vector2Int newPosition, Vector2Int oldPosition) //hide/unhide roof
        {
            bool isEnteringBuilding = dataFromTiles[newPosition].isIndoors;
            if (isEnteringBuilding == dataFromTiles[oldPosition].isIndoors)
            {
                return; //only execute when entering or exiting a building
            }

            float newAlpha;
            Vector2Int roofOrigin;
            if (isEnteringBuilding) //hide roof if entering
            {
                newAlpha = 0f;
                roofOrigin = TileToRoofTile(newPosition);
            }
            else //unhide roof if exiting
            {
                newAlpha = 1f;
                roofOrigin = TileToRoofTile(oldPosition);
            }

            HashSet<Vector2Int> roofTiles = GetConnectedRoofTiles(roofOrigin);
            Vector2Int sector;
            Vector3Int localPosition;
            Color color;

            foreach (Vector2Int roofTile in roofTiles)
            {
                //get sector & position within sector
                sector = GlobalPositionToSector(roofTile);
                localPosition = (Vector3Int)GlobalToSectorPosition(roofTile);

                //update tile color
                color = roofTilemaps[sector].GetColor(localPosition);
                color.a = newAlpha;
                roofTilemaps[sector].SetColor(localPosition, color);
            }
        }

        public static HashSet<Vector2Int> GetConnectedRoofTiles(Vector2Int position)
        {
            HashSet<Vector2Int> connectedRoofs = new HashSet<Vector2Int>();
            HashSet<Vector2Int> visited = new HashSet<Vector2Int>();

            RoofTileDFS(position, connectedRoofs, visited);

            return connectedRoofs;
        }

        public static void RoofTileDFS(Vector2Int position, HashSet<Vector2Int> connectedRoofs, HashSet<Vector2Int> visited)
        {
            if (visited.Contains(position)) //position already checked
            {
                return;
            }

            visited.Add(position);

            if (!dataFromTiles[position].GetRoof(Walls.none)) //check if roof tile exists for this tile
            {
                connectedRoofs.Add(position);

                List<Vector2Int> neighbors = GetRoofNeighbors(position); //check neighboring tiles
                foreach (Vector2Int neighbor in neighbors)
                {
                    RoofTileDFS(neighbor, connectedRoofs, visited);
                }
            }
        }

        public static List<Vector2Int> GetRoofNeighbors(Vector2Int position)
        {
            List<Vector2Int> neighbors = new List<Vector2Int>();

            if (dataFromTiles[position].GetRoof(Walls.northEast)) neighbors.Add(position + new Vector2Int(roofTileDims, 0));
            if (dataFromTiles[position].GetRoof(Walls.southEast)) neighbors.Add(position + new Vector2Int(0, -roofTileDims));
            if (dataFromTiles[position].GetRoof(Walls.southWest)) neighbors.Add(position + new Vector2Int(-roofTileDims, 0));
            if (dataFromTiles[position].GetRoof(Walls.northWest)) neighbors.Add(position + new Vector2Int(0, roofTileDims));

            return neighbors;
        }
        
        /*public static void ToggleRoofVisibility(Vector2Int newPosition, Vector2Int oldPosition) //hide/unhide roof
        {
            bool isEnteringBuilding = dataFromTiles[newPosition].isIndoors;
            if (isEnteringBuilding == dataFromTiles[oldPosition].isIndoors)
            {
                return; //only execute when entering or exiting a building
            }

            float newAlpha;
            Vector2Int roofOrigin;
            if (isEnteringBuilding) //hide roof if entering
            {
                newAlpha = 0f;
                roofOrigin = TileToRoofTile(newPosition);
            }
            else //unhide roof if exiting
            {
                newAlpha = 1f;
                roofOrigin = TileToRoofTile(oldPosition);
            }

            //get sector & position within sector
            Vector2Int sector = GlobalPositionToSector(roofOrigin);
            Vector3Int localPosition = (Vector3Int)GlobalToSectorPosition(roofOrigin);

            Dictionary<Vector2Int, HashSet<Vector3Int>> roofTiles = GetConnectedRoofTiles(sector, localPosition);
            Color color;

            //update tile transparency
            foreach (Vector2Int sectorWithRoofs in roofTiles.Keys)
            {
                foreach (Vector3Int roof in roofTiles[sectorWithRoofs])
                {
                    color = roofTilemaps[sectorWithRoofs].GetColor(roof);
                    color.a = newAlpha;
                    roofTilemaps[sectorWithRoofs].SetColor(roof, color);
                }
            }
        }

        public static Dictionary<Vector2Int, HashSet<Vector3Int>> GetConnectedRoofTiles(Vector2Int sector, Vector3Int position)
        {
            Dictionary<Vector2Int, HashSet<Vector3Int>> connectedRoofs = new Dictionary<Vector2Int, HashSet<Vector3Int>>();
            Dictionary<Vector2Int, HashSet<Vector3Int>> visited = new Dictionary<Vector2Int, HashSet<Vector3Int>>();

            RoofTileDFS(sector, position, connectedRoofs, visited);

            return connectedRoofs;
        }

        public static void RoofTileDFS(Vector2Int sector, Vector3Int position, Dictionary<Vector2Int, HashSet<Vector3Int>> connectedRoofs, Dictionary<Vector2Int, HashSet<Vector3Int>> visited)
        {
            if (!roofTilemaps.ContainsKey(sector)) //sector not loaded
            {
                return;
            }

            if (visited.ContainsKey(sector))
            {
                if (visited[sector].Contains(position)) //position already checked
                {
                    return;
                }
            }
            else
            {
                visited.Add(sector, new HashSet<Vector3Int>());
                connectedRoofs.Add(sector, new HashSet<Vector3Int>());
            }

            visited[sector].Add(position);

            if (roofTilemaps[sector].GetTile(position) != null) //check if roof tile exists
            {
                connectedRoofs[sector].Add(position);

                if (!dataFromTiles[SectorToGlobalPosition((Vector2Int)position, sector)].isIndoors) //don't check neighbors if roof edge
                {
                    return;
                }

                Vector3Int[] neighbors = GetNeighborCoordinates(position, true); //check neighboring tiles
                Vector2Int neighborSector;
                Vector3Int neighborPosition;

                foreach (Vector3Int neighbor in neighbors)
                {
                    neighborSector = sector;
                    neighborPosition = neighbor;
                    CheckIfSameSector(ref neighborSector, ref neighborPosition);

                    RoofTileDFS(neighborSector, neighborPosition, connectedRoofs, visited);
                }
            }
        }

        public static void CheckIfSameSector(ref Vector2Int sector, ref Vector3Int position)
        {
            if (position.x > 0)
            {
                position.x -= sectorDimsTiles;
                sector.x++;
            }
            else if (position.x < -(sectorDimsTiles - 1))
            {
                position.x += sectorDimsTiles;
                sector.x--;
            }

            if (position.y > 0)
            {
                position.y -= sectorDimsTiles;
                sector.y++;
            }
            else if (position.y < -(sectorDimsTiles - 1))
            {
                position.y += sectorDimsTiles;
                sector.y--;
            }
        }*/

        private static NewTileData InvalidTile(bool blocked) //returns invalid tile data with default values
        {
            NewTileData tile = new NewTileData();
            tile.blocked = blocked;
            return tile;
        }

        private float GetPositionOffset(ref byte[] data, int pos, bool xAxis) //gets object position offsets from sec/pro data and converts them to Unity coords 
        {
            int offset = GlobalScript.Global.BytesToInt(ref data, pos, true);
            if (offset > Int32.MaxValue / 2) //negative value
            {
                offset -= Int32.MaxValue;
            }

            if (!xAxis) //Y offset
            {
                offset = -offset;
            }

            return offset * pixelSize; //multiply result by dimensions of 1 pixel in world units
        }

        private void GetObjectArtName(ref byte[] data, int pointer, ref Objects.NewObjectData objData)
        {
            if (objData.art == null)
            {
                if (objData.type == Objects.Types.scenery)
                {
                    GameData.ObjArt.GetSceneryArtName(ref data, pointer, ref objData);
                }
                else
                {
                    objData.art = "hut1ex_lx"; //placeholder
                    //UNFINISHED
                }
            }
        }

        private static void ApplyBlending(SpriteRenderer renderer, Objects.NewObjectData objData) //apply different kinds of blending to object sprite
        {
            if (objData.blendingMode == Graphics.BlendingMode.additive) //additive blending
            {
                renderer.material = Graphics.ShaderManager.Instance.spriteAdditive;
            }
            else if (objData.blendingMode == Graphics.BlendingMode.multiply) //multiply blending
            {
                renderer.material = Graphics.ShaderManager.Instance.spriteMultiply;
            }
        }

        private static Walls IntToWallSide(int value) //converts byte value from .sec files to WallSide enum value
        {
            switch (value)
            {
                case 0:
                    return Walls.northEast;
                case 1:
                    return Walls.southEast;
                case 2:
                    return Walls.southWest;
                case 3:
                    return Walls.northWest;
                default:
                    Debug.Log("Invalid wall side value: " + value);
                    return Walls.none;
            }
        }

        public static Vector2Int TileToRoofTile(Vector2Int position) //converts regular tile position to roof tile position
        {
            Vector2Int remainder = position;
            remainder.x %= roofTileDims;
            remainder.y %= roofTileDims;
            return position - remainder;
        }

        public static Vector2Int SectorToGlobalPosition(Vector2Int position, Vector2Int sector)
        {
            position += sector * sectorDimsTiles;
            return position;
        }

        public static Vector3Int SectorToGlobalPosition(Vector3Int position, Vector2Int sector)
        {
            return (Vector3Int)SectorToGlobalPosition((Vector2Int)position, sector);
        }

        public static Vector2Int GlobalToSectorPosition(Vector2Int position)
        {
            position.x %= sectorDimsTiles;
            position.y %= sectorDimsTiles;
            return position;
        }

        public static Vector3Int GlobalToSectorPosition(Vector3Int position)
        {
            position.x %= sectorDimsTiles;
            position.y %= sectorDimsTiles;
            return position;
        }

        public static Vector2Int GlobalPositionToSector(Vector2Int position) //convert global grid position to sector ID
        {
            position.x = Mathf.CeilToInt((float)position.x / sectorDimsTiles);
            position.y = Mathf.CeilToInt((float)position.y / sectorDimsTiles);
            return position;
        }

        public static Vector2Int GlobalPositionToSector(Vector3Int position) //convert global grid position to sector ID
        {
            return GlobalPositionToSector((Vector2Int)position);
        }

        public static Vector2Int WorldPositionToSector(Vector3 position) //convert world position to sector ID
        {
            return GlobalPositionToSector(GetGrid.WorldToCell(position));
        }

        public static Vector3Int[] GetNeighborCoordinates(Vector3Int position, bool isRoof = false)
        {
            int increment = 1; //normal tile
            if (isRoof) increment = roofTileDims; //roof tile

            return new Vector3Int[]
            {
                position + new Vector3Int(increment, 0, 0),
                position + new Vector3Int(-increment, 0, 0),
                position + new Vector3Int(0, increment, 0),
                position + new Vector3Int(0, -increment, 0)
            };
        }
    }
}
