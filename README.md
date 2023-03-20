# replace-external-link

静态文件资源替换和下载工具

配置路径

## 开发

```
pnpm install
pnpm run start
pnpm link

// 进入需要替换资源的文件夹下面执行
pnpm replace-external-link init
pnpm replace-external-link replace
```

## 发布

```
pnpm build
pnpm pub
```

## 使用

### 安装包

```
pnpm install replace-external-link -g
```

### 初始化配置文件

```
replace-external-link init
```

> 如果不生成配置文件，则使用内置配置文件

内置配置文件

```
module.exports = {
  /** 源替换后协议 */
  protocol: "http",
  /** 源替换后域名 */
  hostname: "127.0.0.1",
  /** 源替换后端口 */
  port: "8087",
  /** 下载文件夹 */
  downloadDir: "download",
  /** 需要替换源的文件夹 */
  sourceDir: "build",
  /** 源替换后输出的文件夹 */
  replacedDir: "replacedDir",
  /** 支持替换源的后缀 */
  extensions: ["js", "css", "json", "jpeg", "jpg", "png", "gif"],
  /** 下载静态文件夹生成地址，如未配置则生成在根目录 */
  downloadDirPath: "",
};
```

### 替换

```
replace-external-link replace
```
