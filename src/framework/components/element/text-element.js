import { string } from '../../../core/string.js';

import { math } from '../../../math/math.js';
import { Color } from '../../../math/color.js';
import { Vec2 } from '../../../math/vec2.js';

import { BoundingBox } from '../../../shape/bounding-box.js';

import { SEMANTIC_POSITION, SEMANTIC_TEXCOORD0, SEMANTIC_COLOR } from '../../../graphics/constants.js';
import { VertexIterator } from '../../../graphics/vertex-iterator.js';

import { createMesh } from '../../../scene/procedural.js';
import { GraphNode } from '../../../scene/graph-node.js';
import { MeshInstance } from '../../../scene/mesh-instance.js';
import { Model } from '../../../scene/model.js';

import { LocalizedAsset } from '../../../asset/asset-localized.js';

import { FONT_BITMAP, FONT_MSDF } from '../../../font/constants.js';

import { Markup } from './markup.js';

class MeshInfo {
    constructor() {
        // number of symbols
        this.count = 0;
        // number of quads created
        this.quad = 0;
        // number of quads on specific line
        this.lines = {};
        // float array for positions
        this.positions = [];
        // float array for normals
        this.normals = [];
        // float array for UVs
        this.uvs = [];
        // float array for vertex colors
        this.colors = [];
        // float array for indices
        this.indices = [];
        // pc.MeshInstance created from this MeshInfo
        this.meshInstance = null;
    }
}

const LINE_BREAK_CHAR = /^[\r\n]$/;
const WHITESPACE_CHAR = /^[ \t]$/;
const WORD_BOUNDARY_CHAR = /^[ \t\-]|[\u200b]$/; // NB \u200b is zero width space
const ALPHANUMERIC_CHAR = /^[a-z0-9]$/i;

// 1100—11FF Hangul Jamo
// 3000—303F CJK Symbols and Punctuation \
// 3130—318F Hangul Compatibility Jamo    -- grouped
// 4E00—9FFF CJK Unified Ideographs      /
// A960—A97F Hangul Jamo Extended-A
// AC00—D7AF Hangul Syllables
// D7B0—D7FF Hangul Jamo Extended-B
const CJK_CHAR = /^[\u1100-\u11ff]|[\u3000-\u9fff]|[\ua960-\ua97f]|[\uac00-\ud7ff]$/;
const NO_LINE_BREAK_CJK_CHAR = /^[〕〉》」』】〙〗〟ヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎゕゖㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ々〻]$/;

// unicode bidi control characters https://en.wikipedia.org/wiki/Unicode_control_characters
const CONTROL_CHARS = [
    '\u200B', // zero width space
    '\u061C',
    '\u200E',
    '\u200F',
    '\u202A',
    '\u202B',
    '\u202C',
    '\u202D',
    '\u202E',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069'
];

// glyph data to use for missing control characters
const CONTROL_GLYPH_DATA = {
    width: 0,
    height: 0,
    xadvance: 0,
    xoffset: 0,
    yoffset: 0
};

class TextElement {
    constructor(element) {
        this._element = element;
        this._system = element.system;
        this._entity = element.entity;

        // public
        this._text = "";            // the original user-defined text
        this._symbols = [];         // array of visible symbols with unicode processing and markup removed
        this._colorPalette = [];    // per-symbol color palette
        this._symbolColors = null;  // per-symbol color indexes. only set for text with markup.
        this._i18nKey = null;

        this._fontAsset = new LocalizedAsset(this._system.app);
        this._fontAsset.disableLocalization = true;
        this._fontAsset.on('load', this._onFontLoad, this);
        this._fontAsset.on('change', this._onFontChange, this);
        this._fontAsset.on('remove', this._onFontRemove, this);

        this._font = null;

        this._color = new Color(1, 1, 1, 1);
        this._colorUniform = new Float32Array(3);

        this._spacing = 1;
        this._fontSize = 32;
        this._fontMinY = 0;
        this._fontMaxY = 0;
        // the font size that is set directly by the fontSize setter
        this._originalFontSize = 32;
        this._maxFontSize = 32;
        this._minFontSize = 8;
        this._autoFitWidth = false;
        this._autoFitHeight = false;
        this._maxLines = -1;
        this._lineHeight = 32;
        this._scaledLineHeight = 32;
        this._wrapLines = false;

        this._drawOrder = 0;

        this._alignment = new Vec2(0.5, 0.5);

        this._autoWidth = true;
        this._autoHeight = true;

        this.width = 0;
        this.height = 0;

        // private
        this._node = new GraphNode();
        this._model = new Model();
        this._model.graph = this._node;
        this._entity.addChild(this._node);

        this._meshInfo = [];
        this._material = null;

        this._aabbDirty = true;
        this._aabb = new BoundingBox();

        this._noResize = false; // flag used to disable resizing events

        this._currentMaterialType = null; // save the material type (screenspace or not) to prevent overwriting
        this._maskedMaterialSrc = null; // saved material that was assigned before element was masked

        this._rtlReorder = false;
        this._unicodeConverter = false;
        this._rtl = false;              // true when the current text is RTL

        this._outlineColor = new Color(0, 0, 0, 1);
        this._outlineColorUniform = new Float32Array(4);
        this._outlineThicknessScale = 0.2; // 0.2 coefficient to map editor range of 0 - 1 to shader value
        this._outlineThickness = 0.0;

        this._shadowColor = new Color(0, 0, 0, 1);
        this._shadowColorUniform = new Float32Array(4);
        this._shadowOffsetScale = 0.005; // maps the editor scale value to shader scale
        this._shadowOffset = new Vec2(0, 0);
        this._shadowOffsetUniform = new Float32Array(2);

        this._enableMarkup = false;

        // initialize based on screen
        this._onScreenChange(this._element.screen);

        // start listening for element events
        element.on('resize', this._onParentResize, this);
        element.on('set:screen', this._onScreenChange, this);
        element.on('screen:set:screenspace', this._onScreenSpaceChange, this);
        element.on('set:draworder', this._onDrawOrderChange, this);
        element.on('set:pivot', this._onPivotChange, this);

        this._system.app.i18n.on('set:locale', this._onLocaleSet, this);
        this._system.app.i18n.on('data:add', this._onLocalizationData, this);
        this._system.app.i18n.on('data:remove', this._onLocalizationData, this);

        // substring render range
        this._rangeStart = 0;
        this._rangeEnd = 0;
    }

    destroy() {
        this._setMaterial(null); // clear material from mesh instances

        if (this._model) {
            this._element.removeModelFromLayers(this._model);
            this._model.destroy();
            this._model = null;
        }

        this._fontAsset.destroy();
        this.font = null;

        this._element.off('resize', this._onParentResize, this);
        this._element.off('set:screen', this._onScreenChange, this);
        this._element.off('screen:set:screenspace', this._onScreenSpaceChange, this);
        this._element.off('set:draworder', this._onDrawOrderChange, this);
        this._element.off('set:pivot', this._onPivotChange, this);

        this._system.app.i18n.off('set:locale', this._onLocaleSet, this);
        this._system.app.i18n.off('data:add', this._onLocalizationData, this);
        this._system.app.i18n.off('data:remove', this._onLocalizationData, this);
    }

    _onParentResize(width, height) {
        if (this._noResize) return;
        if (this._font) this._updateText();
    }

    _onScreenChange(screen) {
        if (screen) {
            this._updateMaterial(screen.screen.screenSpace);
        } else {
            this._updateMaterial(false);
        }
    }

    _onScreenSpaceChange(value) {
        this._updateMaterial(value);
    }

    _onDrawOrderChange(order) {
        this._drawOrder = order;

        if (this._model) {
            var i;
            var len;

            for (i = 0, len = this._model.meshInstances.length; i < len; i++) {
                this._model.meshInstances[i].drawOrder = order;
            }
        }
    }

    _onPivotChange(pivot) {
        if (this._font)
            this._updateText();
    }

    _onLocaleSet(locale) {
        if (!this._i18nKey) return;

        // if the localized font is different
        // then the current font and the localized font
        // is not yet loaded then reset the current font and wait
        // until the localized font is loaded to see the updated text
        if (this.fontAsset) {
            var asset = this._system.app.assets.get(this.fontAsset);
            if (!asset || !asset.resource || asset.resource !== this._font) {
                this.font = null;
            }
        }

        this._resetLocalizedText();
    }

    _onLocalizationData(locale, messages) {
        if (this._i18nKey && messages[this._i18nKey]) {
            this._resetLocalizedText();
        }
    }

    _resetLocalizedText() {
        this._setText(this._system.app.i18n.getText(this._i18nKey));
    }

    _setText(text) {
        if (this.unicodeConverter) {
            var unicodeConverterFunc = this._system.getUnicodeConverter();
            if (unicodeConverterFunc) {
                text = unicodeConverterFunc(text);
            } else {
                console.warn('Element created with unicodeConverter option but no unicodeConverter function registered');
            }
        }

        if (this._text !== text) {
            if (this._font) {
                this._updateText(text);
            }
            this._text = text;
        }
    }

    _updateText(text) {
        var i;
        var len;
        var results;
        var tags;

        if (text === undefined) text = this._text;

        // get the list of symbols
        // NOTE: we must normalize text here in order to be consistent with the number of
        // symbols returned from the bidi algorithm. If we don't, then in some cases bidi
        // returns a different number of RTL codes to what we expect.
        // NOTE: IE doesn't support string.normalize(), so we must check for its existence
        // before invoking.
        this._symbols = string.getSymbols(text.normalize ? text.normalize('NFC') : text);

        // handle null string
        if (this._symbols.length === 0) {
            this._symbols = [" "];
        }

        // extract markup
        if (this._enableMarkup) {
            results = Markup.evaluate(this._symbols);
            this._symbols = results.symbols;
            tags = results.tags;
        }

        // handle LTR vs RTL ordering
        if (this._rtlReorder) {
            var rtlReorderFunc = this._system.app.systems.element.getRtlReorder();
            if (rtlReorderFunc) {
                results = rtlReorderFunc(this._symbols);

                this._rtl = results.rtl;

                // reorder symbols according to unicode reorder mapping
                this._symbols = results.mapping.map(function (v) {
                    return this._symbols[v];
                }, this);

                // reorder tags if they exist, according to unicode reorder mapping
                if (tags) {
                    tags = results.mapping.map(function (v) {
                        return tags[v];
                    });
                }
            } else {
                console.warn('Element created with rtlReorder option but no rtlReorder function registered');
            }
        } else {
            this._rtl = false;
        }

        // resolve color tags
        if (tags) {
            var paletteMap = { };

            // store fallback color in the palette
            this._colorPalette = [
                Math.round(this._color.r * 255),
                Math.round(this._color.g * 255),
                Math.round(this._color.b * 255)
            ];
            this._symbolColors = [];
            paletteMap[this._color.toString(false).toLowerCase()] = 0;

            for (i = 0, len = this._symbols.length; i < len; ++i) {
                var tag = tags[i];
                var color = 0;

                // get markup coloring
                if (tag && tag.color && tag.color.value) {
                    var c = tag.color.value;

                    // resolve color dictionary names
                    // TODO: implement the dictionary of colors
                    // if (colorDict.hasOwnProperty(c)) {
                    //    c = dict[c];
                    // }

                    // convert hex color
                    if (c.length === 7 && c[0] === "#") {
                        var hex = c.substring(1).toLowerCase();

                        if (paletteMap.hasOwnProperty(hex)) {
                            // color is already in the palette
                            color = paletteMap[hex];
                        } else {
                            if (/^([0-9a-f]{2}){3}$/.test(hex)) {
                                // new color
                                color = this._colorPalette.length / 3;
                                paletteMap[hex] = color;
                                this._colorPalette.push(parseInt(hex.substring(0, 2), 16));
                                this._colorPalette.push(parseInt(hex.substring(2, 4), 16));
                                this._colorPalette.push(parseInt(hex.substring(4, 6), 16));
                            }
                        }
                    }
                }

                this._symbolColors.push(color);
            }
        } else {
            // no tags, therefore no per-symbol colors
            this._colorPalette = [];
            this._symbolColors = null;
        }

        var charactersPerTexture = this._calculateCharsPerTexture();

        var removedModel = false;

        var element = this._element;
        var screenSpace = element._isScreenSpace();
        var screenCulled = element._isScreenCulled();
        var visibleFn = function (camera) {
            return element.isVisibleForCamera(camera);
        };

        for (i = 0, len = this._meshInfo.length; i < len; i++) {
            var l = charactersPerTexture[i] || 0;
            var meshInfo = this._meshInfo[i];

            if (meshInfo.count !== l) {
                if (!removedModel) {
                    element.removeModelFromLayers(this._model);
                    removedModel = true;
                }

                meshInfo.count = l;
                meshInfo.positions.length = meshInfo.normals.length = l * 3 * 4;
                meshInfo.indices.length = l * 3 * 2;
                meshInfo.uvs.length = l * 2 * 4;
                meshInfo.colors.length = l * 4 * 4;

                // destroy old mesh
                if (meshInfo.meshInstance) {
                    this._removeMeshInstance(meshInfo.meshInstance);
                }

                // if there are no letters for this mesh continue
                if (l === 0) {
                    meshInfo.meshInstance = null;
                    continue;
                }

                // set up indices and normals whose values don't change when we call _updateMeshes
                for (var v = 0; v < l; v++) {
                    // create index and normal arrays since they don't change
                    // if the length doesn't change
                    meshInfo.indices[v * 3 * 2 + 0] = v * 4;
                    meshInfo.indices[v * 3 * 2 + 1] = v * 4 + 1;
                    meshInfo.indices[v * 3 * 2 + 2] = v * 4 + 3;
                    meshInfo.indices[v * 3 * 2 + 3] = v * 4 + 2;
                    meshInfo.indices[v * 3 * 2 + 4] = v * 4 + 3;
                    meshInfo.indices[v * 3 * 2 + 5] = v * 4 + 1;

                    meshInfo.normals[v * 4 * 3 + 0] = 0;
                    meshInfo.normals[v * 4 * 3 + 1] = 0;
                    meshInfo.normals[v * 4 * 3 + 2] = -1;

                    meshInfo.normals[v * 4 * 3 + 3] = 0;
                    meshInfo.normals[v * 4 * 3 + 4] = 0;
                    meshInfo.normals[v * 4 * 3 + 5] = -1;

                    meshInfo.normals[v * 4 * 3 + 6] = 0;
                    meshInfo.normals[v * 4 * 3 + 7] = 0;
                    meshInfo.normals[v * 4 * 3 + 8] = -1;

                    meshInfo.normals[v * 4 * 3 + 9] = 0;
                    meshInfo.normals[v * 4 * 3 + 10] = 0;
                    meshInfo.normals[v * 4 * 3 + 11] = -1;
                }

                var mesh = createMesh(this._system.app.graphicsDevice,
                                      meshInfo.positions,
                                      {
                                          uvs: meshInfo.uvs,
                                          normals: meshInfo.normals,
                                          colors: meshInfo.colors,
                                          indices: meshInfo.indices
                                      });

                var mi = new MeshInstance(mesh, this._material, this._node);
                mi.name = "Text Element: " + this._entity.name;
                mi.castShadow = false;
                mi.receiveShadow = false;
                mi.cull = !screenSpace;
                mi.screenSpace = screenSpace;
                mi.drawOrder = this._drawOrder;

                if (screenCulled) {
                    mi.cull = true;
                    mi.isVisibleFunc = visibleFn;
                }

                this._setTextureParams(mi, this._font.textures[i]);
                if (this._symbolColors) {
                    // when per-vertex coloring is present, disable material emissive color
                    this._colorUniform[0] = 1;
                    this._colorUniform[1] = 1;
                    this._colorUniform[2] = 1;
                } else {
                    this._colorUniform[0] = this._color.r;
                    this._colorUniform[1] = this._color.g;
                    this._colorUniform[2] = this._color.b;
                }
                mi.setParameter("material_emissive", this._colorUniform);
                mi.setParameter("material_opacity", this._color.a);
                mi.setParameter("font_sdfIntensity", this._font.intensity);
                mi.setParameter("font_pxrange", this._getPxRange(this._font));
                mi.setParameter("font_textureWidth", this._font.data.info.maps[i].width);

                this._outlineColorUniform[0] = this._outlineColor.r;
                this._outlineColorUniform[1] = this._outlineColor.g;
                this._outlineColorUniform[2] = this._outlineColor.b;
                this._outlineColorUniform[3] = this._outlineColor.a;
                mi.setParameter("outline_color", this._outlineColorUniform);
                mi.setParameter("outline_thickness", this._outlineThicknessScale * this._outlineThickness);

                this._shadowColorUniform[0] = this._shadowColor.r;
                this._shadowColorUniform[1] = this._shadowColor.g;
                this._shadowColorUniform[2] = this._shadowColor.b;
                this._shadowColorUniform[3] = this._shadowColor.a;
                mi.setParameter("shadow_color", this._shadowColorUniform);
                var ratio = -this._font.data.info.maps[i].width / this._font.data.info.maps[i].height;
                this._shadowOffsetUniform[0] = this._shadowOffsetScale * this._shadowOffset.x;
                this._shadowOffsetUniform[1] = ratio * this._shadowOffsetScale * this._shadowOffset.y;
                mi.setParameter("shadow_offset", this._shadowOffsetUniform);

                meshInfo.meshInstance = mi;

                this._model.meshInstances.push(mi);

            }
        }

        // after creating new meshes
        // re-apply masking stencil params
        if (this._element.maskedBy) {
            this._element._setMaskedBy(this._element.maskedBy);
        }

        if (removedModel && this._element.enabled && this._entity.enabled) {
            this._element.addModelToLayers(this._model);
        }

        this._updateMeshes();

        // update render range
        this._rangeStart = 0;
        this._rangeEnd = this._symbols.length;
        this._updateRenderRange();
    }

    _removeMeshInstance(meshInstance) {

        meshInstance.material = null;

        var oldMesh = meshInstance.mesh;
        if (oldMesh) {
            oldMesh.destroy();
        }

        var idx = this._model.meshInstances.indexOf(meshInstance);
        if (idx !== -1)
            this._model.meshInstances.splice(idx, 1);
    }

    _setMaterial(material) {
        var i;
        var len;

        this._material = material;
        if (this._model) {
            for (i = 0, len = this._model.meshInstances.length; i < len; i++) {
                var mi = this._model.meshInstances[i];
                mi.material = material;
            }
        }
    }

    _updateMaterial(screenSpace) {
        var element = this._element;
        var screenCulled = element._isScreenCulled();
        var visibleFn = function (camera) {
            return element.isVisibleForCamera(camera);
        };

        var msdf = this._font && this._font.type === FONT_MSDF;
        this._material = this._system.getTextElementMaterial(screenSpace, msdf);

        if (this._model) {
            for (var i = 0, len = this._model.meshInstances.length; i < len; i++) {
                var mi = this._model.meshInstances[i];
                mi.cull = !screenSpace;
                mi.material = this._material;
                mi.screenSpace = screenSpace;

                if (screenCulled) {
                    mi.cull = true;
                    mi.isVisibleFunc = visibleFn;
                } else {
                    mi.isVisibleFunc = null;
                }

            }
        }
    }

    // char is space, tab, or dash
    _isWordBoundary(char) {
        return WORD_BOUNDARY_CHAR.test(char);
    }

    _isValidNextChar(nextchar) {
        return (nextchar !== null) && !NO_LINE_BREAK_CJK_CHAR.test(nextchar);
    }

    // char is a CJK character and next character is a CJK boundary
    _isNextCJKBoundary(char, nextchar) {
        return CJK_CHAR.test(char) && (WORD_BOUNDARY_CHAR.test(nextchar) || ALPHANUMERIC_CHAR.test(nextchar));
    }

    // next character is a CJK character that can be a whole word
    _isNextCJKWholeWord(nextchar) {
        return CJK_CHAR.test(nextchar);
    }

    _updateMeshes() {
        var json = this._font.data;
        var self = this;

        var minFont = Math.min(this._minFontSize, this._maxFontSize);
        var maxFont = this._maxFontSize;

        var autoFit = this._shouldAutoFit();

        if (autoFit) {
            this._fontSize = this._maxFontSize;
        }

        var MAGIC = 32;
        var l = this._symbols.length;
        var _x = 0; // cursors
        var _y = 0;
        var _z = 0;
        var _xMinusTrailingWhitespace = 0;
        var lines = 1;
        var wordStartX = 0;
        var wordStartIndex = 0;
        var lineStartIndex = 0;
        var numWordsThisLine = 0;
        var numCharsThisLine = 0;
        var numBreaksThisLine = 0;
        var splitHorizontalAnchors = Math.abs(this._element.anchor.x - this._element.anchor.z) >= 0.0001;

        var maxLineWidth = this._element.calculatedWidth;
        if ((this.autoWidth && !splitHorizontalAnchors) || !this._wrapLines) {
            maxLineWidth = Number.POSITIVE_INFINITY;
        }

        var fontMinY = 0;
        var fontMaxY = 0;
        var scale = 1;

        var char, data, i, j, quad, nextchar;

        function breakLine(symbols, lineBreakIndex, lineBreakX) {
            self._lineWidths.push(Math.abs(lineBreakX));
            // in rtl mode lineStartIndex will usually be larger than lineBreakIndex and we will
            // need to adjust the start / end indices when calling symbols.slice()
            var sliceStart = lineStartIndex > lineBreakIndex ? lineBreakIndex + 1 : lineStartIndex;
            var sliceEnd = lineStartIndex > lineBreakIndex ? lineStartIndex + 1 : lineBreakIndex;
            var chars = symbols.slice(sliceStart, sliceEnd);

            // Remove line breaks from line.
            // Line breaks would only be there for the final line
            // when we reach the maxLines limit.
            // TODO: We could possibly not do this and just let lines have
            // new lines in them. Apart from being a bit weird it should not affect
            // the rendered text.
            if (numBreaksThisLine) {
                var i = chars.length;
                while (i-- && numBreaksThisLine > 0)  {
                    if (LINE_BREAK_CHAR.test(chars[i])) {
                        chars.splice(i, 1);
                        numBreaksThisLine--;
                    }
                }
            }

            self._lineContents.push(chars.join(''));

            _x = 0;
            _y -= self._scaledLineHeight;
            lines++;
            numWordsThisLine = 0;
            numCharsThisLine = 0;
            numBreaksThisLine = 0;
            wordStartX = 0;
            lineStartIndex = lineBreakIndex;
        }

        var retryUpdateMeshes = true;
        while (retryUpdateMeshes) {
            retryUpdateMeshes = false;

            // if auto-fitting then scale the line height
            // according to the current fontSize value relative to the max font size
            if (autoFit) {
                this._scaledLineHeight = this._lineHeight * this._fontSize / (this._maxFontSize || 0.0001);
            } else {
                this._scaledLineHeight = this._lineHeight;
            }

            this.width = 0;
            this.height = 0;
            this._lineWidths = [];
            this._lineContents = [];

            _x = 0;
            _y = 0;
            _z = 0;
            _xMinusTrailingWhitespace = 0;

            lines = 1;
            wordStartX = 0;
            wordStartIndex = 0;
            lineStartIndex = 0;
            numWordsThisLine = 0;
            numCharsThisLine = 0;
            numBreaksThisLine = 0;

            scale = this._fontSize / MAGIC;

            // scale max font extents
            fontMinY = this._fontMinY * scale;
            fontMaxY = this._fontMaxY * scale;

            for (i = 0; i < this._meshInfo.length; i++) {
                this._meshInfo[i].quad = 0;
                this._meshInfo[i].lines = {};
            }

            // per-vertex color
            var color_r = 255;
            var color_g = 255;
            var color_b = 255;

            // In left-to-right mode we loop through the symbols from start to end.
            // In right-to-left mode we loop through the symbols from end to the beginning
            // in order to wrap lines in the correct order
            for (i = 0; i < l; i++) {
                char = this._symbols[i];
                nextchar = ((i + 1) >= l) ? null : this._symbols[i + 1];

                // handle line break
                const isLineBreak = LINE_BREAK_CHAR.test(char);
                if (isLineBreak) {
                    numBreaksThisLine++;
                    // If we are not line wrapping then we should be ignoring maxlines
                    if (!this._wrapLines || this._maxLines < 0 || lines < this._maxLines) {
                        breakLine(this._symbols, i, _xMinusTrailingWhitespace);
                        wordStartIndex = i + 1;
                        lineStartIndex = i + 1;
                    }
                    continue;
                }

                var x = 0;
                var y = 0;
                var advance = 0;
                var quadsize = 1;
                var dataScale, size;

                data = json.chars[char];

                // handle missing glyph
                if (!data) {
                    if (CONTROL_CHARS.indexOf(char) !== -1) {
                        // handle unicode control characters
                        data = CONTROL_GLYPH_DATA;
                    } else {
                        // otherwise use space character
                        if (json.chars[' ']) {
                            data = json.chars[' '];
                        } else {
                            for (var key in json.chars) {
                                data = json.chars[key];
                                break;
                            }
                        }

                        // #if _DEBUG
                        if (!json.missingChars) {
                            json.missingChars = new Set();
                        }

                        if (!json.missingChars.has(char)) {
                            console.warn("Character '" + char + "' is missing from the font " + json.info.face);
                            json.missingChars.add(char);
                        }
                        // #endif
                    }
                }

                if (data) {
                    var kerning = 0;
                    if (numCharsThisLine > 0) {
                        var kernTable = this._font.data.kerning;
                        if (kernTable) {
                            var kernLeft = kernTable[string.getCodePoint(this._symbols[i - 1]) || 0];
                            if (kernLeft) {
                                kerning = kernLeft[string.getCodePoint(this._symbols[i]) || 0] || 0;
                            }
                        }
                    }
                    dataScale = data.scale || 1;
                    size = (data.width + data.height) / 2;
                    quadsize = scale * size / dataScale;
                    advance = (data.xadvance + kerning) * scale;
                    x = (data.xoffset - kerning) * scale;
                    y = data.yoffset * scale;
                } else {
                    console.error("Couldn't substitute missing character: '" + char + "'");
                }

                var isWhitespace = WHITESPACE_CHAR.test(char);

                var meshInfo = this._meshInfo[(data && data.map) || 0];

                var candidateLineWidth = _x + this._spacing * advance;

                // If we've exceeded the maximum line width, move everything from the beginning of
                // the current word onwards down onto a new line.
                if (candidateLineWidth > maxLineWidth && numCharsThisLine > 0 && !isWhitespace) {
                    if (this._maxLines < 0 || lines < this._maxLines) {
                        // Handle the case where a line containing only a single long word needs to be
                        // broken onto multiple lines.
                        if (numWordsThisLine === 0) {
                            wordStartIndex = i;
                            breakLine(this._symbols, i, _xMinusTrailingWhitespace);
                        } else {
                            // Move back to the beginning of the current word.
                            var backtrack = Math.max(i - wordStartIndex, 0);
                            if (this._meshInfo.length <= 1) {
                                meshInfo.lines[lines - 1] -= backtrack;
                                meshInfo.quad -= backtrack;
                            } else {
                                // We should only backtrack the quads that were in the word from this same texture
                                // We will have to update N number of mesh infos as a result (all textures used in the word in question)
                                var backtrackStart = wordStartIndex;
                                var backtrackEnd = i;
                                for (j = backtrackStart; j < backtrackEnd; j++) {
                                    var backChar = this._symbols[j];
                                    var backCharData = json.chars[backChar];
                                    var backMeshInfo = this._meshInfo[(backCharData && backCharData.map) || 0];
                                    backMeshInfo.lines[lines - 1] -= 1;
                                    backMeshInfo.quad -= 1;
                                }
                            }

                            i -= backtrack + 1;

                            breakLine(this._symbols, wordStartIndex, wordStartX);
                            continue;
                        }
                    }
                }

                quad = meshInfo.quad;
                meshInfo.lines[lines - 1] = quad;

                var left = _x - x;
                var right = left + quadsize;
                var bottom = _y - y;
                var top = bottom + quadsize;

                if (this._rtl) {
                    // rtl text will be flipped vertically before rendering and here we
                    // account for the mis-alignment that would be introduced. shift is calculated
                    // as the difference between the glyph's left and right offset.
                    var shift = quadsize - x - this._spacing * advance - x;
                    left -= shift;
                    right -= shift;
                }

                meshInfo.positions[quad * 4 * 3 + 0] = left;
                meshInfo.positions[quad * 4 * 3 + 1] = bottom;
                meshInfo.positions[quad * 4 * 3 + 2] = _z;

                meshInfo.positions[quad * 4 * 3 + 3] = right;
                meshInfo.positions[quad * 4 * 3 + 4] = bottom;
                meshInfo.positions[quad * 4 * 3 + 5] = _z;

                meshInfo.positions[quad * 4 * 3 + 6] = right;
                meshInfo.positions[quad * 4 * 3 + 7] = top;
                meshInfo.positions[quad * 4 * 3 + 8] = _z;

                meshInfo.positions[quad * 4 * 3 + 9]  = left;
                meshInfo.positions[quad * 4 * 3 + 10] = top;
                meshInfo.positions[quad * 4 * 3 + 11] = _z;

                this.width = Math.max(this.width, candidateLineWidth);

                // scale font size if autoFitWidth is true and the width is larger than the calculated width
                var fontSize;
                if (this._shouldAutoFitWidth() && this.width > this._element.calculatedWidth) {
                    fontSize = Math.floor(this._element.fontSize * this._element.calculatedWidth / (this.width || 0.0001));
                    fontSize = math.clamp(fontSize, minFont, maxFont);
                    if (fontSize !== this._element.fontSize) {
                        this._fontSize = fontSize;
                        retryUpdateMeshes = true;
                        break;
                    }
                }

                this.height = Math.max(this.height, fontMaxY - (_y + fontMinY));

                // scale font size if autoFitHeight is true and the height is larger than the calculated height
                if (this._shouldAutoFitHeight() && this.height > this._element.calculatedHeight) {
                    // try 1 pixel smaller for fontSize and iterate
                    fontSize = math.clamp(this._fontSize - 1, minFont, maxFont);
                    if (fontSize !== this._element.fontSize) {
                        this._fontSize = fontSize;
                        retryUpdateMeshes = true;
                        break;
                    }
                }

                // advance cursor (for RTL we move left)
                _x += this._spacing * advance;

                // For proper alignment handling when a line wraps _on_ a whitespace character,
                // we need to keep track of the width of the line without any trailing whitespace
                // characters. This applies to both single whitespaces and also multiple sequential
                // whitespaces.
                if (!isWhitespace) {
                    _xMinusTrailingWhitespace = _x;
                }

                if (this._isWordBoundary(char) || (this._isValidNextChar(nextchar) && (this._isNextCJKBoundary(char, nextchar) || this._isNextCJKWholeWord(nextchar)))) {
                    numWordsThisLine++;
                    wordStartX = _xMinusTrailingWhitespace;
                    wordStartIndex = i + 1;
                }

                numCharsThisLine++;

                var uv = this._getUv(char);

                meshInfo.uvs[quad * 4 * 2 + 0] = uv[0];
                meshInfo.uvs[quad * 4 * 2 + 1] = 1.0 - uv[1];

                meshInfo.uvs[quad * 4 * 2 + 2] = uv[2];
                meshInfo.uvs[quad * 4 * 2 + 3] = 1.0 - uv[1];

                meshInfo.uvs[quad * 4 * 2 + 4] = uv[2];
                meshInfo.uvs[quad * 4 * 2 + 5] = 1.0 - uv[3];

                meshInfo.uvs[quad * 4 * 2 + 6] = uv[0];
                meshInfo.uvs[quad * 4 * 2 + 7] = 1.0 - uv[3];

                // set per-vertex color
                if (this._symbolColors) {
                    var colorIdx = this._symbolColors[i] * 3;
                    color_r = this._colorPalette[colorIdx];
                    color_g = this._colorPalette[colorIdx + 1];
                    color_b = this._colorPalette[colorIdx + 2];
                }

                meshInfo.colors[quad * 4 * 4 + 0] = color_r;
                meshInfo.colors[quad * 4 * 4 + 1] = color_g;
                meshInfo.colors[quad * 4 * 4 + 2] = color_b;
                meshInfo.colors[quad * 4 * 4 + 3] = 255;

                meshInfo.colors[quad * 4 * 4 + 4] = color_r;
                meshInfo.colors[quad * 4 * 4 + 5] = color_g;
                meshInfo.colors[quad * 4 * 4 + 6] = color_b;
                meshInfo.colors[quad * 4 * 4 + 7] = 255;

                meshInfo.colors[quad * 4 * 4 + 8] = color_r;
                meshInfo.colors[quad * 4 * 4 + 9] = color_g;
                meshInfo.colors[quad * 4 * 4 + 10] = color_b;
                meshInfo.colors[quad * 4 * 4 + 11] = 255;

                meshInfo.colors[quad * 4 * 4 + 12] = color_r;
                meshInfo.colors[quad * 4 * 4 + 13] = color_g;
                meshInfo.colors[quad * 4 * 4 + 14] = color_b;
                meshInfo.colors[quad * 4 * 4 + 15] = 255;

                meshInfo.quad++;
            }

            if (retryUpdateMeshes) {
                continue;
            }

            // As we only break lines when the text becomes too wide for the container,
            // there will almost always be some leftover text on the final line which has
            // not yet been pushed to _lineContents.
            if (lineStartIndex < l) {
                breakLine(this._symbols, l, _x);
            }
        }

        // force autoWidth / autoHeight change to update width/height of element
        this._noResize = true;
        this.autoWidth = this._autoWidth;
        this.autoHeight = this._autoHeight;
        this._noResize = false;

        // offset for pivot and alignment
        var hp = this._element.pivot.x;
        var vp = this._element.pivot.y;
        var ha = this._alignment.x;
        var va = this._alignment.y;

        for (i = 0; i < this._meshInfo.length; i++) {
            if (this._meshInfo[i].count === 0) continue;

            var prevQuad = 0;
            for (var line in this._meshInfo[i].lines) {
                var index = this._meshInfo[i].lines[line];
                var lw = this._lineWidths[parseInt(line, 10)];
                var hoffset = -hp * this._element.calculatedWidth + ha * (this._element.calculatedWidth - lw) * (this._rtl ? -1 : 1);
                var voffset = (1 - vp) * this._element.calculatedHeight - fontMaxY - (1 - va) * (this._element.calculatedHeight - this.height);

                for (quad = prevQuad; quad <= index; quad++) {
                    this._meshInfo[i].positions[quad * 4 * 3] += hoffset;
                    this._meshInfo[i].positions[quad * 4 * 3 + 3] += hoffset;
                    this._meshInfo[i].positions[quad * 4 * 3 + 6] += hoffset;
                    this._meshInfo[i].positions[quad * 4 * 3 + 9] += hoffset;

                    this._meshInfo[i].positions[quad * 4 * 3 + 1] += voffset;
                    this._meshInfo[i].positions[quad * 4 * 3 + 4] += voffset;
                    this._meshInfo[i].positions[quad * 4 * 3 + 7] += voffset;
                    this._meshInfo[i].positions[quad * 4 * 3 + 10] += voffset;
                }

                // flip rtl characters
                if (this._rtl) {
                    for (quad = prevQuad; quad <= index; quad++) {
                        var idx = quad * 4 * 3;

                        // flip the entire line horizontally
                        for (var vert = 0; vert < 4; ++vert) {
                            this._meshInfo[i].positions[idx + vert * 3] =
                                this._element.calculatedWidth - this._meshInfo[i].positions[idx + vert * 3] + hoffset * 2;
                        }

                        // flip the character horizontally
                        var tmp0 = this._meshInfo[i].positions[idx + 3];
                        var tmp1 = this._meshInfo[i].positions[idx + 6];
                        this._meshInfo[i].positions[idx + 3] = this._meshInfo[i].positions[idx + 0];
                        this._meshInfo[i].positions[idx + 6] = this._meshInfo[i].positions[idx + 9];
                        this._meshInfo[i].positions[idx + 0] = tmp0;
                        this._meshInfo[i].positions[idx + 9] = tmp1;
                    }
                }

                prevQuad = index + 1;
            }

            // update vertex buffer
            var numVertices = this._meshInfo[i].count * 4; // number of verts we allocated
            var vertMax = this._meshInfo[i].quad * 4;  // number of verts we need (usually count minus line break characters)
            var it = new VertexIterator(this._meshInfo[i].meshInstance.mesh.vertexBuffer);
            for (var v = 0; v < numVertices; v++) {
                if (v >= vertMax) {
                    // clear unused vertices
                    it.element[SEMANTIC_POSITION].set(0, 0, 0);
                    it.element[SEMANTIC_TEXCOORD0].set(0, 0);
                    it.element[SEMANTIC_COLOR].set(0, 0, 0, 0);
                } else {
                    it.element[SEMANTIC_POSITION].set(this._meshInfo[i].positions[v * 3 + 0], this._meshInfo[i].positions[v * 3 + 1], this._meshInfo[i].positions[v * 3 + 2]);
                    it.element[SEMANTIC_TEXCOORD0].set(this._meshInfo[i].uvs[v * 2 + 0], this._meshInfo[i].uvs[v * 2 + 1]);
                    it.element[SEMANTIC_COLOR].set(this._meshInfo[i].colors[v * 4 + 0],
                                                   this._meshInfo[i].colors[v * 4 + 1],
                                                   this._meshInfo[i].colors[v * 4 + 2],
                                                   this._meshInfo[i].colors[v * 4 + 3]);
                }
                it.next();
            }
            it.end();

            this._meshInfo[i].meshInstance.mesh.aabb.compute(this._meshInfo[i].positions);

            // force update meshInstance aabb
            this._meshInfo[i].meshInstance._aabbVer = -1;
        }

        // flag text element aabb to be updated
        this._aabbDirty = true;
    }

    _onFontRender() {
        // if the font has been changed (e.g. canvasfont re-render)
        // re-applying the same font updates character map and ensures
        // everything is up to date.
        this.font = this._font;
    }

    _onFontLoad(asset) {
        if (this.font !== asset.resource) {
            this.font = asset.resource;
        }
    }

    _onFontChange(asset, name, _new, _old) {
        if (name === 'data') {
            this._font.data = _new;

            var maps = this._font.data.info.maps.length;
            for (var i = 0; i < maps; i++) {
                if (!this._meshInfo[i]) continue;

                var mi = this._meshInfo[i].meshInstance;
                if (mi) {
                    mi.setParameter("font_sdfIntensity", this._font.intensity);
                    mi.setParameter("font_pxrange", this._getPxRange(this._font));
                    mi.setParameter("font_textureWidth", this._font.data.info.maps[i].width);
                }
            }
        }
    }

    _onFontRemove(asset) {

    }

    _setTextureParams(mi, texture) {
        if (this._font) {
            if (this._font.type === FONT_MSDF) {
                mi.deleteParameter("texture_emissiveMap");
                mi.deleteParameter("texture_opacityMap");
                mi.setParameter("texture_msdfMap", texture);
            } else if (this._font.type === FONT_BITMAP) {
                mi.deleteParameter("texture_msdfMap");
                mi.setParameter("texture_emissiveMap", texture);
                mi.setParameter("texture_opacityMap", texture);
            }
        }
    }

    _getPxRange(font) {
        // calculate pxrange from range and scale properties on a character
        var keys = Object.keys(this._font.data.chars);
        for (var i = 0; i < keys.length; i++) {
            var char = this._font.data.chars[keys[i]];
            if (char.range) {
                return (char.scale || 1) * char.range;
            }
        }
        return 2; // default
    }

    _getUv(char) {
        var data = this._font.data;

        if (!data.chars[char]) {
            // missing char - return "space" if we have it
            var space = ' ';
            if (data.chars[space]) {
                return this._getUv(space);
            }

            // otherwise - missing char
            return [0, 0, 0, 0];
        }

        var map = data.chars[char].map;
        var width = data.info.maps[map].width;
        var height = data.info.maps[map].height;

        var x = data.chars[char].x;
        var y =  data.chars[char].y;

        var x1 = x;
        var y1 = y;
        var x2 = (x + data.chars[char].width);
        var y2 = (y - data.chars[char].height);
        var edge = 1 - (data.chars[char].height / height);
        return [
            x1 / width,
            edge - (y1 / height), // bottom left

            (x2 / width),
            edge - (y2 / height)  // top right
        ];
    }

    onEnable() {
        this._fontAsset.autoLoad = true;

        if (this._model) {
            this._element.addModelToLayers(this._model);
        }
    }

    onDisable() {
        this._fontAsset.autoLoad = false;

        if (this._model) {
            this._element.removeModelFromLayers(this._model);
        }
    }

    _setStencil(stencilParams) {
        if (this._model) {
            var instances = this._model.meshInstances;
            for (var i = 0; i < instances.length; i++) {
                instances[i].stencilFront = stencilParams;
                instances[i].stencilBack = stencilParams;
            }
        }
    }

    _shouldAutoFitWidth() {
        return this._autoFitWidth && !this._autoWidth;
    }

    _shouldAutoFitHeight() {
        return this._autoFitHeight && !this._autoHeight;
    }

    _shouldAutoFit() {
        return this._autoFitWidth && !this._autoWidth ||
               this._autoFitHeight && !this._autoHeight;
    }

    // calculate the number of characters per texture up to, but not including
    // the specified symbolIndex
    _calculateCharsPerTexture(symbolIndex) {
        var charactersPerTexture = {};

        if (symbolIndex === undefined) {
            symbolIndex = this._symbols.length;
        }

        var i, len, char, info, map;
        for (i = 0, len = symbolIndex; i < len; i++) {
            char = this._symbols[i];
            info = this._font.data.chars[char];
            if (!info) {
                // if char is missing use 'space' or first char in map
                info = this._font.data.chars[' '];
                if (!info) {
                    // otherwise if space is also not present use the first character in the
                    // set
                    info = this._font.data.chars[Object.keys(this._font.data.chars)[0]];
                }
            }

            map = info.map;
            if (!charactersPerTexture[map]) {
                charactersPerTexture[map] = 1;
            } else {
                charactersPerTexture[map]++;
            }
        }
        return charactersPerTexture;
    }

    _updateRenderRange() {
        var startChars = this._rangeStart === 0 ? 0 : this._calculateCharsPerTexture(this._rangeStart);
        var endChars = this._rangeEnd === 0 ? 0 : this._calculateCharsPerTexture(this._rangeEnd);

        var i, len;
        for (i = 0, len = this._meshInfo.length; i < len; i++) {
            var start = startChars[i] || 0;
            var end = endChars[i] || 0;
            var instance = this._meshInfo[i].meshInstance;
            if (instance) {
                var mesh = instance.mesh;
                if (mesh) {
                    mesh.primitive[0].base = start * 3 * 2;
                    mesh.primitive[0].count = (end - start) * 3 * 2;
                }
            }
        }
    }

    get text() {
        return this._text;
    }

    set text(value) {
        this._i18nKey = null;
        var str = value != null && value.toString() || "";
        this._setText(str);
    }

    get key() {
        return this._i18nKey;
    }

    set key(value) {
        var str = value !== null ? value.toString() : null;
        if (this._i18nKey === str) {
            return;
        }

        this._i18nKey = str;
        if (str) {
            this._fontAsset.disableLocalization = false;
            this._resetLocalizedText();
        } else {
            this._fontAsset.disableLocalization = true;
        }
    }

    get color() {
        return this._color;
    }

    set color(value) {
        var r = value.r;
        var g = value.g;
        var b = value.b;

        // #if _DEBUG
        if (this._color === value) {
            console.warn("Setting element.color to itself will have no effect");
        }
        // #endif

        if (this._color.r === r && this._color.g === g && this._color.b === b) {
            return;
        }

        this._color.r = r;
        this._color.g = g;
        this._color.b = b;

        if (this._symbolColors) {
            // color is baked into vertices, update text
            if (this._font) {
                this._updateText();
            }
        } else {
            this._colorUniform[0] = this._color.r;
            this._colorUniform[1] = this._color.g;
            this._colorUniform[2] = this._color.b;

            for (var i = 0, len = this._model.meshInstances.length; i < len; i++) {
                var mi = this._model.meshInstances[i];
                mi.setParameter('material_emissive', this._colorUniform);
            }
        }
    }

    get opacity() {
        return this._color.a;
    }

    set opacity(value) {
        if (this._color.a === value) return;

        this._color.a = value;

        if (this._model) {
            for (var i = 0, len = this._model.meshInstances.length; i < len; i++) {
                var mi = this._model.meshInstances[i];
                mi.setParameter('material_opacity', value);
            }
        }
    }

    get lineHeight() {
        return this._lineHeight;
    }

    set lineHeight(value) {
        var _prev = this._lineHeight;
        this._lineHeight = value;
        this._scaledLineHeight = value;
        if (_prev !== value && this._font) {
            this._updateText();
        }
    }

    get wrapLines() {
        return this._wrapLines;
    }

    set wrapLines(value) {
        var _prev = this._wrapLines;
        this._wrapLines = value;
        if (_prev !== value && this._font) {
            this._updateText();
        }
    }

    get lines() {
        return this._lineContents;
    }

    get spacing() {
        return this._spacing;
    }

    set spacing(value) {
        var _prev = this._spacing;
        this._spacing = value;
        if (_prev !== value && this._font) {
            this._updateText();
        }
    }

    get fontSize() {
        return this._fontSize;
    }

    set fontSize(value) {
        var _prev = this._fontSize;
        this._fontSize = value;
        this._originalFontSize = value;
        if (_prev !== value && this._font) {
            this._updateText();
        }
    }

    get fontAsset() {
        // getting fontAsset returns the currently used localized asset
        return this._fontAsset.localizedAsset;
    }

    set fontAsset(value) {
        // setting the fontAsset sets the default assets which in turn
        // will set the localized asset to be actually used
        this._fontAsset.defaultAsset = value;
    }

    get font() {
        return this._font;
    }

    set font(value) {
        var i;
        var len;

        var previousFontType;

        if (this._font) {
            previousFontType = this._font.type;

            // remove render event listener
            if (this._font.off) this._font.off('render', this._onFontRender, this);
        }

        this._font = value;

        this._fontMinY = 0;
        this._fontMaxY = 0;

        if (!value) return;

        // calculate min / max font extents from all available chars
        var json = this._font.data;
        for (var charId in json.chars) {
            var data = json.chars[charId];
            if (data.bounds) {
                this._fontMinY = Math.min(this._fontMinY, data.bounds[1]);
                this._fontMaxY = Math.max(this._fontMaxY, data.bounds[3]);
            }
        }

        // attach render event listener
        if (this._font.on) this._font.on('render', this._onFontRender, this);

        if (this._fontAsset.localizedAsset) {
            var asset = this._system.app.assets.get(this._fontAsset.localizedAsset);
            // if we're setting a font directly which doesn't match the asset
            // then clear the asset
            if (asset.resource !== this._font) {
                this._fontAsset.defaultAsset = null;
            }
        }

        // if font type has changed we may need to get change material
        if (value.type !== previousFontType) {
            var screenSpace = this._element._isScreenSpace();
            this._updateMaterial(screenSpace);
        }

        // make sure we have as many meshInfo entries
        // as the number of font textures
        for (i = 0, len = this._font.textures.length; i < len; i++) {
            if (!this._meshInfo[i]) {
                this._meshInfo[i] = new MeshInfo();
            } else {
                // keep existing entry but set correct parameters to mesh instance
                var mi = this._meshInfo[i].meshInstance;
                if (mi) {
                    mi.setParameter("font_sdfIntensity", this._font.intensity);
                    mi.setParameter("font_pxrange", this._getPxRange(this._font));
                    mi.setParameter("font_textureWidth", this._font.data.info.maps[i].width);
                    this._setTextureParams(mi, this._font.textures[i]);
                }
            }
        }

        // destroy any excess mesh instances
        var removedModel = false;
        for (i = this._font.textures.length; i < this._meshInfo.length; i++) {
            if (this._meshInfo[i].meshInstance) {
                if (!removedModel) {
                    // remove model from scene so that excess mesh instances are removed
                    // from the scene as well
                    this._element.removeModelFromLayers(this._model);
                    removedModel = true;
                }
                this._removeMeshInstance(this._meshInfo[i].meshInstance);
            }
        }

        if (this._meshInfo.length > this._font.textures.length)
            this._meshInfo.length = this._font.textures.length;

        this._updateText();
    }

    get alignment() {
        return this._alignment;
    }

    set alignment(value) {
        if (value instanceof Vec2) {
            this._alignment.set(value.x, value.y);
        } else {
            this._alignment.set(value[0], value[1]);
        }

        if (this._font)
            this._updateText();
    }

    get autoWidth() {
        return this._autoWidth;
    }

    set autoWidth(value) {
        var old = this._autoWidth;
        this._autoWidth = value;

        // change width of element to match text width but only if the element
        // does not have split horizontal anchors
        if (value && Math.abs(this._element.anchor.x - this._element.anchor.z) < 0.0001) {
            this._element.width = this.width;
        }

        // restore fontSize if autoWidth changed
        if (old !== value) {
            var newFontSize = this._shouldAutoFit() ? this._maxFontSize : this._originalFontSize;
            if (newFontSize !== this._fontSize) {
                this._fontSize = newFontSize;
                if (this._font) {
                    this._updateText();
                }
            }
        }
    }

    get autoHeight() {
        return this._autoHeight;
    }

    set autoHeight(value) {
        var old = this._autoHeight;
        this._autoHeight = value;

        // change height of element to match text height but only if the element
        // does not have split vertical anchors
        if (value && Math.abs(this._element.anchor.y - this._element.anchor.w) < 0.0001) {
            this._element.height = this.height;
        }

        // restore fontSize if autoHeight changed
        if (old !== value) {
            var newFontSize = this._shouldAutoFit() ? this._maxFontSize : this._originalFontSize;
            if (newFontSize !== this._fontSize) {
                this._fontSize = newFontSize;
                if (this._font) {
                    this._updateText();
                }
            }
        }
    }

    get rtlReorder() {
        return this._rtlReorder;
    }

    set rtlReorder(value) {
        if (this._rtlReorder !== value) {
            this._rtlReorder = value;
            if (this._font) {
                this._updateText();
            }
        }
    }

    get unicodeConverter() {
        return this._unicodeConverter;
    }

    set unicodeConverter(value) {
        if (this._unicodeConverter !== value) {
            this._unicodeConverter = value;
            this._setText(this._text);
        }
    }

    // private
    get aabb() {
        if (this._aabbDirty) {
            var initialized = false;
            for (var i = 0; i < this._meshInfo.length; i++) {
                if (! this._meshInfo[i].meshInstance) continue;

                if (! initialized) {
                    this._aabb.copy(this._meshInfo[i].meshInstance.aabb);
                    initialized = true;
                } else {
                    this._aabb.add(this._meshInfo[i].meshInstance.aabb);
                }
            }

            this._aabbDirty = false;
        }
        return this._aabb;
    }

    get outlineColor() {
        return this._outlineColor;
    }

    set outlineColor(value) {
        var r = (value instanceof Color) ? value.r : value[0];
        var g = (value instanceof Color) ? value.g : value[1];
        var b = (value instanceof Color) ? value.b : value[2];
        var a = (value instanceof Color) ? value.a : value[3];

        // #if _DEBUG
        if (this._outlineColor === value) {
            console.warn("Setting element.outlineColor to itself will have no effect");
        }
        // #endif

        if (this._outlineColor.r === r &&
            this._outlineColor.g === g &&
            this._outlineColor.b === b &&
            this._outlineColor.a === a) {
            return;
        }

        this._outlineColor.r = r;
        this._outlineColor.g = g;
        this._outlineColor.b = b;
        this._outlineColor.a = a;

        if (this._model) {
            this._outlineColorUniform[0] = this._outlineColor.r;
            this._outlineColorUniform[1] = this._outlineColor.g;
            this._outlineColorUniform[2] = this._outlineColor.b;
            this._outlineColorUniform[3] = this._outlineColor.a;

            for (var i = 0, len = this._model.meshInstances.length; i < len; i++) {
                var mi = this._model.meshInstances[i];
                mi.setParameter("outline_color", this._outlineColorUniform);
            }
        }
    }

    get outlineThickness() {
        return this._outlineThickness;
    }

    set outlineThickness(value) {
        var _prev = this._outlineThickness;
        this._outlineThickness = value;
        if (_prev !== value && this._font) {
            if (this._model) {
                for (var i = 0, len = this._model.meshInstances.length; i < len; i++) {
                    var mi = this._model.meshInstances[i];
                    mi.setParameter("outline_thickness", this._outlineThicknessScale * this._outlineThickness);
                }
            }
        }
    }

    get shadowColor() {
        return this._shadowColor;
    }

    set shadowColor(value) {
        var r = (value instanceof Color) ? value.r : value[0];
        var g = (value instanceof Color) ? value.g : value[1];
        var b = (value instanceof Color) ? value.b : value[2];
        var a = (value instanceof Color) ? value.a : value[3];

        // #if _DEBUG
        if (this._shadowColor === value) {
            console.warn("Setting element.shadowColor to itself will have no effect");
        }
        // #endif

        if (this._shadowColor.r === r &&
            this._shadowColor.g === g &&
            this._shadowColor.b === b &&
            this._shadowColor.a === a) {
            return;
        }

        this._shadowColor.r = r;
        this._shadowColor.g = g;
        this._shadowColor.b = b;
        this._shadowColor.a = a;

        if (this._model) {
            this._shadowColorUniform[0] = this._shadowColor.r;
            this._shadowColorUniform[1] = this._shadowColor.g;
            this._shadowColorUniform[2] = this._shadowColor.b;
            this._shadowColorUniform[3] = this._shadowColor.a;

            for (var i = 0, len = this._model.meshInstances.length; i < len; i++) {
                var mi = this._model.meshInstances[i];
                mi.setParameter("shadow_color", this._shadowColorUniform);
            }
        }
    }

    get shadowOffset() {
        return this._shadowOffset;
    }

    set shadowOffset(value) {
        var x = (value instanceof Vec2) ? value.x : value[0],
            y = (value instanceof Vec2) ? value.y : value[1];
        if (this._shadowOffset.x === x && this._shadowOffset.y === y) {
            return;
        }
        this._shadowOffset.set(x, y);

        if (this._font && this._model) {
            for (var i = 0, len = this._model.meshInstances.length; i < len; i++) {
                var ratio = -this._font.data.info.maps[i].width / this._font.data.info.maps[i].height;
                this._shadowOffsetUniform[0] = this._shadowOffsetScale * this._shadowOffset.x;
                this._shadowOffsetUniform[1] = ratio * this._shadowOffsetScale * this._shadowOffset.y;
                var mi = this._model.meshInstances[i];
                mi.setParameter("shadow_offset", this._shadowOffsetUniform);
            }
        }
    }

    get minFontSize() {
        return this._minFontSize;
    }

    set minFontSize(value) {
        if (this._minFontSize === value) return;
        this._minFontSize = value;

        if (this.font && this._shouldAutoFit()) {
            this._updateText();
        }
    }

    get maxFontSize() {
        return this._maxFontSize;
    }

    set maxFontSize(value) {
        if (this._maxFontSize === value) return;
        this._maxFontSize = value;

        if (this.font && this._shouldAutoFit()) {
            this._updateText();
        }
    }

    get autoFitWidth() {
        return this._autoFitWidth;
    }

    set autoFitWidth(value) {
        if (this._autoFitWidth === value) return;
        this._autoFitWidth = value;

        this._fontSize = this._shouldAutoFit() ? this._maxFontSize : this._originalFontSize;
        if (this.font) {
            this._updateText();
        }
    }

    get autoFitHeight() {
        return this._autoFitHeight;
    }

    set autoFitHeight(value) {
        if (this._autoFitHeight === value) return;
        this._autoFitHeight = value;

        this._fontSize = this._shouldAutoFit() ? this._maxFontSize : this._originalFontSize;
        if (this.font) {
            this._updateText();
        }
    }

    get maxLines() {
        return this._maxLines;
    }

    set maxLines(value) {
        if (this._maxLines === value) return;
        if (value === null && this._maxLines === -1) return;

        this._maxLines = (value === null ? -1 : value);

        if (this.font && this._wrapLines) {
            this._updateText();
        }
    }

    get enableMarkup() {
        return this._enableMarkup;
    }

    set enableMarkup(value) {
        value = !!value;
        if (this._enableMarkup === value) return;

        this._enableMarkup = value;

        if (this.font) {
            this._updateText();
        }
    }

    get symbols() {
        return this._symbols;
    }

    get symbolColors() {
        if (this._symbolColors === null) {
            return null;
        }
        return this._symbolColors.map(function (c) {
            return this._colorPalette.slice(c * 3, c * 3 + 3);
        }, this);
    }

    get rtl() {
        return this._rtl;
    }

    get rangeStart() {
        return this._rangeStart;
    }

    set rangeStart(rangeStart) {
        rangeStart = Math.max(0, Math.min(rangeStart, this._symbols.length));

        if (rangeStart !== this._rangeStart) {
            this._rangeStart = rangeStart;
            this._updateRenderRange();
        }
    }

    get rangeEnd() {
        return this._rangeEnd;
    }

    set rangeEnd(rangeEnd) {
        rangeEnd = Math.max(this._rangeStart, Math.min(rangeEnd, this._symbols.length));

        if (rangeEnd !== this._rangeEnd) {
            this._rangeEnd = rangeEnd;
            this._updateRenderRange();
        }
    }
}

export { TextElement };
