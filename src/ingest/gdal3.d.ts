/**
 * The part of gdal3.js (GDAL compiled to WebAssembly) the ENC reader uses.
 * The package's own types declare its browser entry only.
 */
declare module "gdal3.js/node.js" {
  interface Gdal3Dataset {
    pointer: number;
    path: string;
    /** ogrinfo's summary, which open() runs on every vector dataset. */
    info?: { layers?: { name: string }[] };
  }
  interface Gdal3 {
    open(files: string | string[]): Promise<{ datasets: Gdal3Dataset[]; errors: unknown[] }>;
    /** Writes `/output/<outputName>.<ext>` in the in-memory file system. */
    ogr2ogr(
      dataset: Gdal3Dataset,
      options: string[],
      outputName: string
    ): Promise<{ local: string }>;
    close(dataset: Gdal3Dataset): Promise<void>;
    Module: {
      FS: { readFile(path: string): Uint8Array; unlink(path: string): void };
    };
  }
  function initGdalJs(config?: {
    /** Directory of the `.wasm` and `.data` files, relative to the working directory. */
    path?: string;
    env?: Record<string, string>;
    logHandler?: (message: string, type: string) => void;
    errorHandler?: (message: string, type: string) => void;
  }): Promise<Gdal3>;
  export = initGdalJs;
}
