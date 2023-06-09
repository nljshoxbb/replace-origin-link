import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { globSync } from "glob";
import { downloadFile, formatBytes, getFolderSizeByGlob, multibar, readFile, writeFile } from "./utils";
import * as chalk from "chalk";
import { CONFIG_FILE_NAME, MAP_FILE_NAME } from "./constant";
import * as puppeteer from "puppeteer";
import startServer from "./server";

const config = require("./config");
const pLimit = require("p-limit");

type TLinkType = "relative" | "absolute";

type TDownloadResult = {
  success: number;
  fail: number;
};

type TServer = {
  host: string;
  port: number;
};

type TFileInfo = {
  replace: string;
  filePath: string;
  status?: "success" | "fail";
};

class Generator {
  hostname: string;
  port: string;
  protocol: string;
  downloadDir: string;
  /** 下载后的文件路径 */
  downloadDirPath: string;
  /** 替换后的文件路径 */
  replacedDirPath: string;
  /** 替换后输出的文件夹 */
  replacedDir: string;
  /** 需要替换源的文件夹 */
  sourceDir: string;
  /** 下载资源地址集合 */
  downloadUrls: string[];
  /** 动态加载的url，无法通过扫描的代码中匹配到http请求地址 */
  dynamicallyLoadUrls: string[];
  /** 替换路径 */
  linkType: TLinkType;
  downloadResult: TDownloadResult;
  /** 已下载url */
  downloadedList: string[];
  /** 已替换的文件路径 */
  replacedFileList: string[];
  /** 打印log */
  printLog: boolean;
  /** puppeteer访问服务 */
  server: TServer;
  /** 是否生成映射文件 */
  mappingFile: boolean;
  dev: boolean;
  detail: Record<string, TFileInfo[]>;
  replacedRecord: Record<string, string>;
  /** 临时文件 */
  replaceTempDir: string;
  /** 临时文件 */
  downloadTempDir: string;
  downloadTempDirPath: string;

  extentions: string[];
  constructor(printLog, dev) {
    console.time("time");
    this.printLog = printLog;
    this.dev = dev;
    this.linkType = "absolute";
    this.replacedRecord = {};
    this.extentions = ["css", "js", "png", "json", "svg", "gif"];
    this.downloadUrls = [];
    this.dynamicallyLoadUrls = [];
    this.downloadResult = {
      success: 0,
      fail: 0,
    };
    this.downloadedList = [];
    this.replacedFileList = [];
    this.server = {
      host: "127.0.0.1",
      port: 8120,
    };
    this.detail = {};
    this.replacedDirPath = path.resolve(this.replacedDir);
    this.downloadDirPath = path.join(process.cwd(), this.downloadDir);
    this.replaceTempDir = "./replaceTemp";
    this.downloadTempDir = "./downloadTemp";
    this.downloadTempDirPath = path.resolve(this.downloadTempDir);

    this.init();
  }

  setDefaultConfig = (params) => {
    this.hostname = params.hostname;
    this.port = params.port;
    this.protocol = params.protocol;
    this.downloadDir = params.downloadDir;
    this.sourceDir = params.sourceDir;
    this.replacedDir = params.replacedDir;
    this.linkType = params.linkType;
    this.mappingFile = params.mappingFile;
  };

  getConfigFile = async () => {
    const configFilePath = path.join(process.cwd(), CONFIG_FILE_NAME);
    if (fs.existsSync(configFilePath)) {
      const data = require(configFilePath);
      this.setDefaultConfig(data);
    } else {
      this.setDefaultConfig(config);
    }
  };

  async init() {
    this.getConfigFile();
    this.removeDir();
    await this.getData(this.sourceDir);
    await this.checkHttpMissingLinks();
    this.generateDir();
    this.mappingFile && this.generateMap();
    this.displayStatistics();
  }

  removeDir = () => {
    fs.removeSync(this.downloadDirPath);
    if (this.sourceDir !== this.replacedDir) {
      fs.removeSync(this.replacedDirPath);
    }
  };

  generateDir = () => {
    const tempDirPath = path.resolve(this.replaceTempDir);
    fs.copySync(tempDirPath, this.replacedDirPath, { overwrite: true });
    fs.removeSync(tempDirPath);
    const downloadTempDirPath = path.resolve(this.downloadTempDir);
    fs.copySync(downloadTempDirPath, this.downloadDirPath, { overwrite: true });
    fs.removeSync(downloadTempDirPath);
  };

  async getData(dir) {
    try {
      const newFiles = this.scanDir(dir);
      await this.replaceFiles(newFiles);
      const links = this.downloadUrls.filter((x) => !this.downloadedList.includes(x));
      // console.log(links, newFiles);
      if (links.length === 0) {
        return;
      }
      await this.fetchStaticResources(links);
      await this.getData(this.downloadTempDir);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject();
    }
  }

  scanDir = (dirPath): string[] => {
    console.log(chalk.cyan(`开始扫描${path.resolve(dirPath)}`));
    /** 扫描当前文件 */
    const results = globSync(`${dirPath}/**`, {
      stat: true,
      withFileTypes: true,
      ignore: ["node_modules/**", ".lock"],
    });

    const files = results.map((path) => path.fullpath());
    return files;
  };

  replaceFiles = async (files) => {
    console.log(chalk.cyan(`匹配替换链接路径 `));
    const sourceDir = path.basename(path.resolve(this.sourceDir));
    const replacedDir = path.basename(path.resolve(this.replacedDir));
    const replaceTempDir = path.basename(path.resolve(this.replaceTempDir));
    for (const filePath of [...files]) {
      const content = await readFile(filePath);
      const replacedContent = this.replaceContent(content, filePath);
      let REGEX,
        TEMP,
        REPLACE = "";
      // 需兼容 win linux 路径问题
      const platform = os.platform();
      if (platform === "darwin") {
        REGEX = new RegExp(`/${sourceDir}`, "g");
        REPLACE = `/${replacedDir}`;
        TEMP = `/${replaceTempDir}`;
      } else if (platform === "win32") {
        REGEX = new RegExp(`\\\\${sourceDir}`, "g");
        REPLACE = `\\${replacedDir}`;
        TEMP = `/${replaceTempDir}`;
      }
      const replacedPath = filePath.replace(REGEX, REPLACE);
      const replacedTmpPath = filePath.replace(REGEX, TEMP);
      const extname = path.extname(replacedPath);
      this.replacedFileList.push(filePath);
      if (!extname) {
        fs.ensureDirSync(replacedTmpPath);
      } else {
        /** 先写入缓存文件夹再生成指定目录 */
        if (!this.replacedRecord[replacedTmpPath]) {
          await writeFile(replacedTmpPath, replacedContent);
          this.replacedRecord[replacedTmpPath] = replacedTmpPath;
        }
      }
    }
    return Promise.resolve();
  };

  replaceContent = (content: string, filePath: string) => {
    let newContent = "";
    const ALL_SCRIPT_REGEX = /(<script[\s\S]*?>)[\s\S]*?<\/script>/gi;
    const SCRIPT_TAG_REGEX = /<(script)\s+((?!type=('|")text\/ng-template\3).)*?>.*?<\/\1>/is;
    const SCRIPT_SRC_REGEX = /.*\ssrc=('|")?([^>'"\s]+)/;
    /**
     *  'url:"http://123.com"'
     */

    const extentionStr = this.extentions.join("|");
    const HTTP_REGEX_FILE = new RegExp(
      `"(https?:\/\/[^\\s"]+?\.(?:${extentionStr}))"|'(https?:\/\/[^\\s']+\\.(?:${extentionStr}))'|"\/\/[^\\s"]+?\\.(?:${extentionStr})"`,
      "gi"
    );
    // /"(https?:\/\/[^\s"]+?\.(?:css...))"|'(https?:\/\/[^\s']+\.(?:css...))'|"\/\/[^\s"]+?\.(?:css...|ico)"/gi;
    /**
     * css file
     * url("// ... .woff2?t=1638951976966")
     * url(// ... .woff2?t=1638951976966)
     * url(http:// ....)
     */
    const HTTP_REGEX_CSS_INNER_URL =
      /url(\(\/\/[^\s"]+?\.?\))|url(\("\/\/[^\s"]+?\.?"\))|url(\('\/\/[^\s"]+?\.?'\))|url(\(https?:\/\/[^\s"]+?\.?\))/gi;

    if (!content || content.length === 0) {
      return newContent;
    }

    const fileType = path.extname(filePath);

    if (fileType === ".html" || fileType === ".ejs") {
      // 处理html资源中的外链
      newContent = content
        .replace(ALL_SCRIPT_REGEX, (match, scriptTag) => {
          if (SCRIPT_TAG_REGEX.test(match) && scriptTag.match(SCRIPT_SRC_REGEX)) {
            const matchedScriptSrcMatch = scriptTag.match(SCRIPT_SRC_REGEX);
            let matchedScriptSrc = matchedScriptSrcMatch && matchedScriptSrcMatch[2];
            if (matchedScriptSrc.includes("http")) {
              if (matchedScriptSrc.includes("??")) {
                const [requestPrefix, collectionStr] = matchedScriptSrc.split("??");
                /** 阿里静态资源聚合请求拆分
                 *  例如 https://g.alicdn.com/platform/c/??react15-polyfill/0.0.1/dist/index.js,lodash/4.6.1/lodash.min.js
                 */
                let sources = collectionStr.split(",");
                let newScriptTag = sources.map((k) => {
                  const scriptSrc = `${requestPrefix}${k}`;

                  if (HTTP_REGEX_FILE.test(scriptSrc)) {
                    this.addDownloadUrls(scriptSrc);
                  }
                  // 拆为多个script标签进行加载
                  return `\n    <script src="${scriptSrc}"></script>`;
                });
                return newScriptTag;
              } else if (HTTP_REGEX_FILE.test(matchedScriptSrc)) {
                this.addDownloadUrls(matchedScriptSrc);
              }
            }
          }
          return match;
        })
        .replace(HTTP_REGEX_FILE, (match) => {
          this.addDownloadUrls(match);
          const replaceUrl = this.replaceOrigin(match, filePath);
          return replaceUrl;
        });
    } else if (fileType === ".css") {
      newContent = content.replace(HTTP_REGEX_CSS_INNER_URL, (match) => {
        const singleQuotes = /[']/g.test(match);
        const doubleQuotes = /["]/g.test(match);
        const str = match.match(/\(([^)]+)\)/);
        let matchString = str[1];

        if (singleQuotes || doubleQuotes) {
          matchString = this.removeQuotes(matchString);
        }
        let url = matchString.includes("http") ? matchString : `http:${matchString}`;
        this.addDownloadUrls(url);
        if (doubleQuotes) {
          url = `"${url}"`;
        } else if (singleQuotes) {
          url = `'${url}'`;
        }
        const replaceUrl = this.replaceOrigin(url, filePath);

        return `url(${replaceUrl})`;
      });
    } else {
      newContent = content.replace(HTTP_REGEX_FILE, (match) => {
        if (match.includes("http")) {
          this.addDownloadUrls(match);
          return this.replaceOrigin(match, filePath);
        } else {
          // const singleQuotes = /[']/g.test(match);
          // const doubleQuotes = /["]/g.test(match);
          // let url = `http:${this.removeQuotes(match)}`;
          // this.addDownloadUrls(url);
          // if (doubleQuotes) {
          //   url = `"${url}"`;
          // } else if (singleQuotes) {
          //   url = `'${url}'`;
          // }
          // return this.replaceOrigin(url, filePath);
        }
      });
    }
    return newContent;
  };

  fetchStaticResources = async (urls: string[]) => {
    console.log(chalk.cyan(`开始下载文件到${this.downloadTempDirPath}`));

    try {
      const limit = pLimit(10);
      const input: Promise<any>[] = [];

      for (const [idx, url] of urls.entries()) {
        const parsed = new URL(url);
        const index = parsed.pathname.lastIndexOf("/");
        const pathstr = index === 0 ? "" : parsed.pathname.substring(0, index + 1);
        const downloadTempPath = path.join(path.resolve(this.downloadTempDir), pathstr);
        /** 先写入缓存文件夹再生成指定目录 */
        fs.ensureDirSync(downloadTempPath);
        const destPath = path.join(downloadTempPath, path.basename(parsed.pathname));
        input.push(
          limit(() => {
            return new Promise(async (resolve, reject) => {
              this.downloadedList.push(url);
              try {
                console.log(url);
                await downloadFile(url, destPath, this.printLog);
                resolve(true);
                this.detail[url] = this.detail[url].map((i) => {
                  i.status = "success";
                  return i;
                });
              } catch (error) {
                this.detail[url] = this.detail[url].map((i) => {
                  i.status = "fail";
                  return i;
                });
                reject(error);
              }
            });
          })
        );
      }
      const result = await Promise.allSettled(input);
      multibar.stop();
      result.forEach((i) => {
        if (i.status === "fulfilled") {
          this.downloadResult.success += 1;
        } else {
          /** 失败时删除文件 */
          // @ts-ignore
          if (i.reason.outputPath) {
            // @ts-ignore
            // fs.unlink(i.reason.outputPath, (err) => {
            //   if (err) {
            //     console.log(err);
            //   }
            // });
          }
          this.downloadResult.fail += 1;
        }
      });
      return Promise.resolve();
    } catch (error) {
      console.log(error);
      return Promise.reject();
    }
  };

  addDownloadUrls = (url: string) => {
    const item = this.removeQuotes(url);
    if (!this.downloadUrls.includes(item)) {
      this.downloadUrls.push(item);
    }
  };

  removeDownloadUrls = (url: string) => {
    const idx = this.downloadUrls.indexOf(url);
    this.downloadUrls = this.downloadUrls.slice(idx, 1);
  };

  removeQuotes = (url) => {
    return url.replace(/['"]/g, "");
  };

  /** 替换源 */
  replaceOrigin = (originUrl: string, filePath) => {
    const singleQuotes = /[']/g.test(originUrl);
    const doubleQuotes = /["]/g.test(originUrl);
    let url;
    if (singleQuotes || doubleQuotes) {
      url = new URL(this.removeQuotes(originUrl));
    } else {
      url = new URL(originUrl);
    }

    const downloadDirName = path.basename(path.resolve(this.downloadDir));

    let replaceUrl = "";
    if (this.linkType === "relative") {
      replaceUrl = `/${downloadDirName}${url.pathname}`;
    } else {
      url.hostname = this.hostname;
      url.port = this.port;
      url.pathname = `/${downloadDirName}${url.pathname}`;
      url.protocol = this.protocol;
      replaceUrl = url.href;
    }

    const relativePath = filePath.split(process.cwd())[1];
    if (this.detail[url]) {
      this.detail[url].push({
        filePath: relativePath,
        replace: replaceUrl,
      });
    } else {
      this.detail[url] = [{ filePath: relativePath, replace: this.removeQuotes(replaceUrl) }];
    }

    if (singleQuotes) {
      replaceUrl = `'${replaceUrl}'`;
    } else if (doubleQuotes) {
      replaceUrl = `"${replaceUrl}"`;
    }

    return replaceUrl;
  };

  /** 检查http替换遗漏链接,主要为js中动态加载js链接 */
  checkHttpMissingLinks = async () => {
    try {
      console.log(chalk.cyan("检查链接是否下载完毕..."));
      /** 启动http服务提供给puppeteer打开； pupperter 通过 file:// 打开时无法访问localstorge导致工程没启动 */
      const server = startServer(this.sourceDir, this.server.port);
      const browser = await puppeteer.launch({
        headless: !this.dev,
        devtools: true,
      });
      const page = await browser.newPage();
      await page.setRequestInterception(true); //开启请求拦截
      page.on("request", (interceptedRequest) => {
        const url = interceptedRequest.url();
        if (!this.downloadUrls.includes(url)) {
          this.printLog && console.log(chalk.cyan(`puppeteer intercepted request ${url}`));
          const urlIns = new URL(url);
          if (urlIns.hostname !== this.server.host) {
            this.dynamicallyLoadUrls.push(url);
          }
        }
        if (interceptedRequest.isInterceptResolutionHandled()) return;
        if (interceptedRequest.url().endsWith(".png") || interceptedRequest.url().endsWith(".jpg"))
          interceptedRequest.abort();
        else interceptedRequest.continue();
      });
      const href = `http://${this.server.host}:${this.server.port}`;
      console.log(chalk.cyan(`puppeteer goto ${href}`));
      await page.goto(href);
      await browser.close();
      server.close();

      if (this.dynamicallyLoadUrls.length > 0) {
        await this.fetchStaticResources(this.dynamicallyLoadUrls);
      }
    } catch (error) {
      console.log(error);
    }
  };

  generateMap = () => {
    const mapPath = path.resolve(MAP_FILE_NAME);
    fs.writeFileSync(path.resolve(MAP_FILE_NAME), JSON.stringify(this.detail, null, 2), "utf-8");
    console.log(chalk.cyan(`生成映射文件成功 ${mapPath}`));
  };

  displayStatistics = () => {
    const { success, fail } = this.downloadResult;
    const structDatas = [
      { request: "all", total: this.downloadResult.fail + this.downloadResult.success },
      { request: "success", total: success },
      { request: "fail", total: fail },
    ];
    const size = getFolderSizeByGlob(this.downloadDirPath, { ignorePattern: [] });

    console.log(`${chalk.cyan("链接替换完成!")}`);
    console.log(`${chalk.yellow("replacedDirPath")}: ${chalk.green(this.replacedDirPath)}`);
    console.log(`${chalk.yellow("downloadDirPath")}: ${chalk.green(`${this.downloadDirPath}`)}`);
    console.log(`${chalk.yellow("downloadSize")}: ${chalk.green(`${formatBytes(size)}`)}`);
    console.log(`${chalk.yellow("replaceOrigin")}: ${chalk.green(`${this.protocol}://${this.hostname}:${this.port}`)}`);
    console.timeEnd("time");
    console.table(structDatas);
  };
}

export default Generator;
