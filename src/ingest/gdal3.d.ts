/**
 * The part of gdal3.js (GDAL compiled to WebAssembly) the ENC reader uses.
 * The package's own types declare its browser entry only.
 */
declare module "gdal3.js/node.js" {
  interface Gdal3Dataset {
    pointer: number;
    path: string;
  }
  interface Gdal3 {
    open(files: string[]): Promise<{ datasets: Gdal3Dataset[]; errors: string[] }>;
    ogrinfo(dataset: Gdal3Dataset, options: string[]): Promise<unknown>;
    close(dataset: Gdal3Dataset): Promise<void>;
  }
  function initGdalJs(config?: {
    env?: Record<string, string>;
    logHandler?: (message: string, type: string) => void;
    errorHandler?: (message: string, type: string) => void;
  }): Promise<Gdal3>;
  export = initGdalJs;
}
