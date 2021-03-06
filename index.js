var fs = require('fs');
var path = require('path');
var es = require('event-stream');
var glob = require('glob');
var PluginError = require('plugin-error');
var colors = require('ansi-colors');
var applySourceMap = require('vinyl-sourcemaps-apply');
// var stripBom = require('strip-bom');

var stripBom = function stripBom(string) {
    if (Buffer.isBuffer(string)) {
        string = string.toString();
    }

	if (typeof string !== 'string') {
		throw new TypeError(`Expected a string, got ${typeof string}`);
	}

	// Catches EFBBBF (UTF-8 BOM) because the buffer-to-string
	// conversion translates it to FEFF (UTF-16 BOM).
	if (string.charCodeAt(0) === 0xFEFF) {
		return string.slice(1);
	}

	return string;
}

module.exports = function(params) {
    params = params || {};

    var SourceMapGenerator = require('source-map').SourceMapGenerator;
    var SourceMapConsumer = require('source-map').SourceMapConsumer;

    var extensions = null; // The extension to be searched after
    var globalIncludedFiles = []; // To track what files have been included over all files
    var includePaths = false; // The paths to be searched
    var hardFail = false; // Throw error when no match
    var separateInputs = false; // Process each input file separately when using `require` directive

    // 添加埋点：对匹配引入进行再次更新
    var includeTrim = function (includePath, filePath) {
        if (params.includeTrim) {
            return params.includeTrim(includePath, filePath);
        }
        
        return includePath;
    }

    // Check for includepaths in the params
    if (params.includePaths) {
        // { alias: path }
        includePaths = params.includePaths;
        // if (typeof params.includePaths == 'string') {
        //     // Arrayify the string
        //     includePaths = [params.includePaths];
        // } else if (Array.isArray(params.includePaths)) {
        //     // Set this array to the includepaths
        //     includePaths = params.includePaths;
        // }
    }

    if (params.separateInputs) {
        separateInputs = true;
    }

    // Toggle error reporting
    if (params.hardFail != undefined) {
        hardFail = params.hardFail;
    }

    if (params.extensions) {
        extensions = typeof params.extensions === 'string' ? [params.extensions] : params.extensions;
    }

    function include(file, callback) {
        var includedFiles = separateInputs ? [] : globalIncludedFiles;

        if (file.isNull()) {
            return callback(null, file);
        }

        if (file.isStream()) {
            throw new PluginError('gulp-include', 'stream not supported');
        }

        if (file.isBuffer()) {
            var result = processInclude(String(file.contents), file.path, file.sourceMap, includedFiles);
            file.contents = new Buffer(result.content);

            if (file.sourceMap && result.map) {
                if (Object.prototype.toString.call(result.map) === '[object String]') {
                    result.map = JSON.parse(result.map);
                }

                // relative-ize the paths in the map
                result.map.file = path.relative(file.base, result.map.file);
                result.map.sources.forEach(function(source, q) {
                    result.map.sources[q] = path.relative(file.base, result.map.sources[q]);
                });

                applySourceMap(file, result.map);
            }
        }

        callback(null, file);
    }

    function processInclude(content, filePath, sourceMap, includedFiles, extendFilePath) {
        if (extendFilePath === undefined) {
            extendFilePath = filePath;
        }

        // 检测是否使用了继承文件
        var extendes = content.match(/^(\s+)?(\/\/|\/\*|\#|\<\!\-\-)(\s+)?=(\s+)?(extend)(.*$)/mg);
        if (extendes) {
            // 使用了继承文件，将不使用当前文件插槽外编写的内容
            var extend = extendes[0];
            var extendSrc = extend
                .replace(/\s+/g, ' ')
                .replace(/(\/\/|\/\*|\#|<!--)(\s+)?=(\s+)?/g, '')
                .replace(/(\*\/|-->)$/g, '')
                .replace(/['"]/g, '')
                .trim()
                .split(' ')[1];

            if (extendSrc) {
                var _extend_content = '';

                if (includePaths != false && !isExplicitRelativePath(extendSrc)) {
                    // If includepaths are set, search in those folders
                    for (var y in includePaths) {
                        if (extendSrc.indexOf(y + '/') == 0) {
                            var _includePath = includePaths[y] + extendSrc.slice(y.length);

                            _includePath = includeTrim(_includePath, extendFilePath);

                            _extend_content = glob.sync(_includePath, {
                                mark: true
                            });

                            if (_extend_content) {
                                break;
                            }
                        }
                    }

                } else {
                    // Otherwise search relatively
                    var _includePath = relativeBasePath + '/' + removeRelativePathPrefix(extendSrc);

                    _includePath = includeTrim(_includePath, extendFilePath);

                    _extend_content = glob.sync(_includePath, {
                        mark: true
                    });
                }
                // 获取继承文件内容
                if (_extend_content) {
                    _extend_content = stripBom(fs.readFileSync(_includePath));
                    _extend_content = _extend_content.toString();

                    // 设置的代码提前转换一遍引入内容
                    // _extend_content = processInclude(_extend_content, _includePath, sourceMap, includedFiles).content;
                }

                // 获取继承文件插槽  = block:slotname
                var blocks = _extend_content.match(/^(\s+)?(\/\/|\/\*|\#|\<\!\-\-)(\s+)?=(\s+)?(block:([\w_-]+))(.*$)/mg);
                var block_names = [];

                if (blocks) {
                    for (var i = 0; i < blocks.length; i++) {
                        var block = blocks[i];
                        var block_name = block.replace(/\s+/g, ' ')
                            .replace(/(\/\/|\/\*|\#|<!--)(\s+)?=(\s+)?/g, '')
                            .replace(/(\*\/|-->)$/g, '')
                            .replace(/['"]/g, '')
                            .trim();

                        // 获取对应插槽位置的内容并追加到对应位置
                        var extendContent = '';

                        var startMarks = content.match(new RegExp(`^(\\s+)?(\\/\\/|\\/\\*|\\#|\\<\\!\\-\\-)(\\s+)?\\^(\\s+)?(${block_name})(.*$)`, `mg`));

                        if (!startMarks) {
                            continue;
                        }

                        var startMark = startMarks[0];

                        var endMarks = content.match(new RegExp(`^(\\s+)?(\\/\\/|\\/\\*|\\#|\\<\\!\\-\\-)(\\s+)?\\$(\\s+)?(${block_name})(.*$)`, `mg`));

                        if (!endMarks) {
                            continue;
                        }

                        var endMark = endMarks[0];

                        var startLocalIndex = content.indexOf(startMark) + startMark.length;
                        var endLocalIndex = content.indexOf(endMark);

                        // 获取设置的部分代码
                        extendContent = content.substring(startLocalIndex, endLocalIndex).trim();

                        // 开始替换
                        _extend_content = _extend_content.replace(block, function() {
                            return extendContent;
                        });
                    }
                }

                // 清除掉没用的extend
                for (var i = 1; i < extendes.length; i++) {
                    content = content.replace(extendes[i], '');
                }

                // 使用整理好的内容重新执行当前函数
                return processInclude(_extend_content, filePath, sourceMap, includedFiles, extendFilePath ? extendFilePath : filePath);
            }
        } else {
            // 清除掉没用的调用block
            content.replace(new RegExp(`^(\\s+)?(\\/\\/|\\/\\*|\\#|\\<\\!\\-\\-)(\\s+)?\\^(\\s+)?(${block_name})(.*$)`, `mg`), '');
            content.replace(new RegExp(`^(\\s+)?(\\/\\/|\\/\\*|\\#|\\<\\!\\-\\-)(\\s+)?\\$(\\s+)?(${block_name})(.*$)`, `mg`), '');
        }

        var matches = content.match(/^(\s+)?(\/\/|\/\*|\#|\<\!\-\-)(\s+)?=(\s+)?(include|require)(.+$)/mg);
        var relativeBasePath = path.dirname(filePath);

        if (!matches) {
            return {
                content: content,
                map    : null
            };
        }

        // Apply sourcemaps
        var map = null;
        var mapSelf; var lastMappedLine; var currentPos; var insertedLines;
        if (sourceMap) {
            map = new SourceMapGenerator({
                file: unixStylePath(filePath)
            });
            lastMappedLine = 1;
            currentPos = 0;
            insertedLines = 0;

            mapSelf = function(currentLine) { // maps current file between matches and after all matches
                var currentOrigLine = currentLine - insertedLines;

                for (var q = (currentLine - lastMappedLine); q > 0; q--) {
                    map.addMapping({
                        generated: {
                            line  : currentLine - q,
                            column: 0
                        },
                        original: {
                            line  : currentOrigLine - q,
                            column: 0
                        },
                        source: filePath
                    });
                }

                lastMappedLine = currentLine;
            };
        }

        for (var i = 0; i < matches.length; i++) {
            var leadingWhitespaceMatch = matches[i].match(/^\s*/);
            var leadingWhitespace = null;
            if (leadingWhitespaceMatch) {
                leadingWhitespace = leadingWhitespaceMatch[0].replace('\n', '');
            }

            // Remove beginnings, endings and trim.
            var includeCommand = matches[i]
                .replace(/\s+/g, ' ')
                .replace(/(\/\/|\/\*|\#|<!--)(\s+)?=(\s+)?/g, '')
                .replace(/(\*\/|-->)$/g, '')
                .replace(/['"]/g, '')
                .trim();

            var split = includeCommand.split(' ');

            var currentLine;
            if (sourceMap) {
                // get position of current match and get current line number
                currentPos = content.indexOf(matches[i], currentPos);
                currentLine = currentPos === -1 ? 0 : content.substr(0, currentPos).match(/^/mg).length;

                // sometimes the line matches the leading \n and sometimes it doesn't. wierd.
                // in case it does, increment the current line counter
                if (leadingWhitespaceMatch[0][0] == '\n') currentLine++;

                mapSelf(currentLine);
            }

            // SEARCHING STARTS HERE
            // Split the directive and the path
            var includeType = split[0];

            // Use glob for file searching
            var fileMatches = [];
            var includePath = '';

            if (includePaths != false && !isExplicitRelativePath(split[1])) {
                let matched = false;
                // If includepaths are set, search in those folders
                for (var y in includePaths) {
                    if (split[1].indexOf(y + '/') == 0) {
                        includePath = includePaths[y] + split[1].slice(y.length);

                        includePath = includeTrim(includePath, extendFilePath);

                        var globResults = glob.sync(includePath, {
                            mark: true
                        });
                        fileMatches = fileMatches.concat(globResults);
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    includePath = split[1];

                    includePath = includeTrim(includePath, extendFilePath);

                    fileMatches = fileMatches.concat(glob.sync(includePath, {
                        mark: true
                    }));
                }
            } else {
                // Otherwise search relatively
                includePath = relativeBasePath + '/' + removeRelativePathPrefix(split[1]);

                includePath = includeTrim(includePath, filePath);

                fileMatches = glob.sync(includePath, {
                    mark: true
                });
            }

            if (fileMatches.length < 1) fileNotFoundError(includePath);

            var replaceContent = '';
            for (var y = 0; y < fileMatches.length; y++) {
                var globbedFilePath = fileMatches[y];

                // If directive is of type "require" and file already included, skip to next.
                if (includeType == 'require' && includedFiles.indexOf(globbedFilePath) > -1) continue;

                // If not in extensions, skip this file
                if (!inExtensions(globbedFilePath)) continue;

                // Get file contents and apply recursive include on result
                // Unicode byte order marks are stripped from the start of included files
                var fileContents = stripBom(fs.readFileSync(globbedFilePath));

                var result = processInclude(fileContents.toString(), globbedFilePath, sourceMap, includedFiles, extendFilePath ? extendFilePath : filePath);
                var resultContent = result.content;

                if (sourceMap) {
                    var lines = resultContent.match(/^/mg).length; // count lines in result

                    if (result.map) { // result had a map, merge mappings
                        if (Object.prototype.toString.call(result.map) === '[object String]') {
                            result.map = JSON.parse(result.map);
                        }

                        if (result.map.mappings && result.map.mappings.length > 0) {
                            var resultMap = new SourceMapConsumer(result.map);
                            resultMap.eachMapping(function(mapping) {
                                if (!mapping.source) return;

                                map.addMapping({
                                    generated: {
                                        line  : mapping.generatedLine + currentLine - 1,
                                        column: mapping.generatedColumn + (leadingWhitespace ? leadingWhitespace.length : 0)
                                    },
                                    original: {
                                        line  : mapping.originalLine,
                                        column: mapping.originalColumn
                                    },
                                    source: mapping.source,
                                    name  : mapping.name
                                });
                            });

                            if (result.map.sourcesContent) {
                                result.map.sourcesContent.forEach(function(sourceContent, i) {
                                    map.setSourceContent(result.map.sources[i], sourceContent);
                                });
                            }
                        }
                    } else { // result was a simple file, map whole file to new location
                        for (var q = 0; q < lines; q++) {
                            map.addMapping({
                                generated: {
                                    line  : currentLine + q,
                                    column: leadingWhitespace ? leadingWhitespace.length : 0
                                },
                                original: {
                                    line  : q + 1,
                                    column: 0
                                },
                                source: globbedFilePath
                            });
                        }

                        if (sourceMap.sourcesContent) {
                            map.setSourceContent(globbedFilePath, resultContent);
                        }
                    }

                    // increment/set map line counters
                    insertedLines += lines;
                    currentLine += lines;
                    lastMappedLine = currentLine;
                }

                if (includedFiles.indexOf(globbedFilePath) == -1) includedFiles.push(globbedFilePath);

                // If the last file did not have a line break, and it is not the last file in the matched glob,
                // add a line break to the end
                if (!resultContent.trim().match(/\n$/) && y != fileMatches.length - 1) {
                    resultContent += '\n';
                }

                if (leadingWhitespace) resultContent = addLeadingWhitespace(leadingWhitespace, resultContent);

                replaceContent += resultContent;
            }

            // REPLACE
            if (replaceContent.length) {
                // sometimes the line matches the leading \n and sometimes it doesn't. wierd.
                // in case it does, preserve that leading \n
                if (leadingWhitespaceMatch[0][0] === '\n') {
                    replaceContent = '\n' + replaceContent;
                }

                content = content.replace(matches[i], function() {
                    return replaceContent;
                });
                insertedLines--; // adjust because the original line with comment was removed
            }
        }

        if (sourceMap) {
            currentLine = content.match(/^/mg).length + 1;

            mapSelf(currentLine);
        }

        return {
            content: content,
            map    : map ? map.toString() : null
        };
    }

    function unixStylePath(filePath) {
        return filePath.replace(/\\/g, '/');
    }

    function addLeadingWhitespace(whitespace, string) {
        return string.split('\n').map(function(line) {
            return whitespace + line;
        }).join('\n');
    }

    function isExplicitRelativePath(filePath) {
        return filePath.indexOf('.') === 0;
        // return filePath.indexOf('./') === 0;
    }

    function removeRelativePathPrefix(filePath) {
        return filePath.replace(/^\.\//, '');
    }
    function fileNotFoundError(includePath) {
        if (hardFail) {
            throw new PluginError('gulp-include', 'No files found matching ' + includePath);
        } else {
            console.warn(
                colors.yellow('WARN: ') +
                colors.cyan('gulp-include') +
                ' - no files found matching ' + includePath
            );
        }
    }

    function inExtensions(filePath) {
        if (!extensions) return true;
        for (var i = 0; i < extensions.length; i++) {
            var re = extensions[i] + '$';
            if (filePath.match(re)) return true;
        }
        return false;
    }

    return es.map(include);
};
