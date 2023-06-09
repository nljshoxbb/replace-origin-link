# replace-origin-link

资源替换工具

> 提供资源链接路径替换和下载文件

配置路径

## 开发

```
pnpm install
pnpm run start
pnpm link

```

## 发布

```
pnpm build
pnpm pub
```

## 使用

### 安装包

```
pnpm install replace-origin-link -g
```

### 初始化配置文件

```
replace-origin-link init
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
  /** 源文件已下载存放位置 */
  downloadDir: "./replace_build/download",
  /** 需要替换源链接的文件夹 */
  sourceDir: "./build",
  /** 源替换后输出的文件夹 */
  replacedDir: "./replace_build",
  /** 生成映射文件 */
  mappingFile: true,
};
```

### 替换

```
replace-origin-link replace
```

### 打印详细信息

```
replace-origin-link replace --verbose
```
