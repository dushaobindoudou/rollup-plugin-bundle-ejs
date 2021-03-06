import { statSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { relative, basename, sep as pathSeperator } from 'path';

const htmlMinifier = require('html-minifier');
const hasha = require('hasha');
const fse = require('fs-extra');

const cheerio = require('cheerio');
const { compile } = require('ejs');

function traverse(dir, list) {
    const dirList = readdirSync(dir);
    dirList.forEach(node => {
        const file = `${dir}/${node}`;
        if (statSync(file).isDirectory()) {
            traverse(file, list);
        } else if (/\.js$/.test(file)) {
            list.push({ type: 'js', file });
        } else if (/\.css$/.test(file)) {
            list.push({ type: 'css', file });
        }
    });
}

function isURL(url) {
    return new RegExp('^(?:[a-z]+:)?//', 'i').test(url);
}

const renderCode = (templateFn, renderOption) => {
    if (renderOption) {
        const { data, minifierOptions } = renderOption;
        return minifierOptions
            ? htmlMinifier.minify(templateFn(data), minifierOptions)
            : templateFn(data);
    }

    return templateFn.toString();
};

const defaultCompilerOptions = { client: true, strict: true };

export default (opt = {}) => {
    const {
        template,
        filename,
        externals,
        inject,
        dest,
        absolute,
        ignore,
        onlinePath,
        renderOption,
        isAppendLocalFile,
        compilerOptions = defaultCompilerOptions,
    } = opt;

    return {
        name: 'bundle-ejs',
        writeBundle(config, data) {
            if (!template) {
                console.error('template参数不能为空');
                return;
            }
            const isHTML = /^.*<html>.*<\/html>$/.test(template);
            const htmlData = isHTML ? template : readFileSync(template).toString();

            const templateFn = compile(
                htmlData,
                Object.assign(defaultCompilerOptions, compilerOptions),
            );

            const resHtml = renderCode(templateFn, renderOption);
            const $ = cheerio.load(resHtml);
            const head = $('head');
            const body = $('body');
            let entryConfig = {};

            Object.values(config).forEach(c => {
                if (c.isEntry) {
                    entryConfig = c;
                }
            });

            const { fileName, sourcemap } = entryConfig;
            const fileList = [];

            const destPath = relative('./', fileName);
            const destDir = dest || destPath.slice(0, destPath.indexOf(pathSeperator));
            const destFile = `${destDir}/${filename || basename(template)}`;
            const absolutePathPrefix = absolute ? '/' : '';

            if (isAppendLocalFile) {
                traverse(destDir, fileList);
            }

            if (Array.isArray(externals)) {
                let firstBundle = 0;
                externals.forEach(node => {
                    if (node.pos === 'before') {
                        firstBundle += 1;
                        fileList.splice(firstBundle, 0, node);
                    } else {
                        fileList.splice(fileList.length, 0, node);
                    }
                });
            }

            fileList.forEach(node => {
                const { type } = node;
                let { file } = node;
                if (ignore && file.match(ignore)) {
                    return;
                }

                let hash = '';
                let code = '';

                if (/\[hash\]/.test(file)) {
                    if (file === destPath) {
                        // data.code will remove the last line of the source code(//# sourceMappingURL=xxx), so it's needed to add this
                        code = `${data.code}//# sourceMappingURL=${basename(file)}.map`;
                    } else {
                        code = readFileSync(file).toString();
                    }
                    if (sourcemap) {
                        let srcmapFile = `${file}.map`;
                        const srcmapCode = readFileSync(srcmapFile).toString();
                        const srcmapHash = hasha(srcmapCode, { algorithm: 'md5' });

                        // remove the source map file without hash
                        unlinkSync(srcmapFile);
                        srcmapFile = srcmapFile.replace('[hash]', srcmapHash);
                        fse.outputFileSync(srcmapFile, srcmapCode);

                        code = code.replace(
                            `//# sourceMappingURL=${basename(file)}.map`,
                            `//# sourceMappingURL=${basename(srcmapFile)}`,
                        );
                    }
                    hash = hasha(code, { algorithm: 'md5' });
                    // remove the file without hash
                    unlinkSync(file);
                    file = file.replace('[hash]', hash);
                    fse.outputFileSync(file, code);
                }

                let src = isURL(file)
                    ? file
                    : absolutePathPrefix + relative(destDir, file).replace(/\\/g, '/');
                if (onlinePath) {
                    const fName = file.split('/').slice(-1)[0];
                    const slash = onlinePath.slice(-1) === '/' ? '' : '/';
                    src = onlinePath + slash + fName;
                }
                if (node.timestamp) {
                    src += `?t=${new Date().getTime()}`;
                }

                if (type === 'js') {
                    const script = `<script type="text/javascript" src="${src}"></script>\n`;
                    // node.inject will cover the inject
                    if (node.inject === 'head' || inject === 'head') {
                        head.append(script);
                    } else {
                        body.append(script);
                    }
                } else if (type === 'css') {
                    head.append(`<link rel="stylesheet" href="${src}">\n`);
                }
            });
            fse.outputFileSync(destFile, $.html());
        },
    };
};
