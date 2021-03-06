#### gulp-include-extend

> gulp-include 简单扩展版

增加功能：

- 模板文件定义（以html文件为示例）：

```html
<!-- extend.html -->

<html>
    <head></head>
    <body>
        <!-- = block:main -->
    </body>
</html>
```

- 使用模板文件：

```html
<!-- index.html -->

    <!-- = extend extend.html -->

    <!-- ^ block:main -->
        <p>Hello world</p>
    <!-- $ block:main -->
```

- 生成的文件为

```html
<html>
    <head></head>
    <body>
        <p>Hello world</p>
    </body>
</html>
```

解释：

1. 定义模板插槽：

```
<!-- = block:[插槽名称] -->
```

2. 引入模板文件：

```
<!-- = extend [模板文件路径] -->
```

引入模板文件后，在下方写的代码全部不会识别，除非引入插槽。

3. 引入插槽：向插槽中填入内容

在引入模板文件后写入：

```
<!-- ^ block:[插槽名称] -->
插入内容
<!-- $ block:[插槽名称] -->
```

以上两个语法是成对存在的，插槽名称必须设置相同，且与模板文件定义的插槽名称相同。

---

- includePaths 转义前处理（v1.2.5）

对于定义了 includePaths 的配置但是无法分文件处理的情况，开放了include处理前操作

```
{
    includeTrim: function (includePath, filePath) {
        return includePath;
    }
}
```

其中，`includePath` 为引入模板定义地址，`filePath` 为文件流文件地址，返回值为处理后的 `includePath`，且必须返回