/**
 * This widget renders the visualization defined by a VisualizationModel onto
 * a canvas element that will fill the parent element.
 */
cinema.views.VisualizationCanvasWidget = Backbone.View.extend({
    // Expose primitive events from the canvas for building interactors
    events: {
        'click .c-vis-render-canvas': function (e) {
            this.trigger('c:click', e);
        },
        'dblclick .c-vis-render-canvas': function (e) {
            this.trigger('c:dblclick', e);
        },
        'mousedown .c-vis-render-canvas': function (e) {
            this.trigger('c:mousedown', e);
        },
        'mousemove .c-vis-render-canvas': function (e) {
            this.trigger('c:mousemove', e);
        },
        'mouseup .c-vis-render-canvas': function (e) {
            this.trigger('c:mouseup', e);
        },
        'mousewheel .c-vis-render-canvas': function (e) {
            this.trigger('c:mousewheel', e);
        },
        'keypress .c-vis-render-canvas': function (e) {
            this.trigger('c:keypress', e);
        },
        'contextmenu .c-vis-render-canvas': function (e) {
            e.preventDefault();
        }
    },

    initialize: function (settings) {
        var args = settings.visModel.get('arguments');

        this.visModel = settings.visModel;
        this.query = settings.query || "AABBCBDBEBFBGCHCICJCKC"; // TODO figure out what this means
        this.drawingCenter = settings.drawingCenter || [0, 0];
        this.zoomLevel = settings.zoomLevel || 1.0;
        this.backgroundColor = settings.backgroundColor || '#ffffff';
        this.orderMapping = {};
        this.viewpoint = settings.viewpoint || {
            time: args.time['default'],
            phi: args.phi['default'],
            theta: args.theta['default']
        };

        this.compositeManager = new cinema.utilities.CompositeImageManager({
            visModel: this.visModel
        });

        this._computeLayerOffset();
        this._first = true;

        this.compositeManager.on('c:error', function (e) {
            this.trigger('c:error', e);
        }, this).on('c:data.ready', function (data) {
            this._writeCompositeBuffer(data);

            if (this._first) {
                this._first = false;
                this.resetCamera();
            }

            this.drawImage();
        }, this);
    },

    render: function () {
        this.$el.html(cinema.templates.visCanvas());

        // Fetch and render the default phi/time/theta image.
        return this.showViewpoint();
    },

    _computeOffset: function (order) {
        for (var i = 0; i < order.length; i += 1) {
            var offset = this.layerOffset[order[i]];
            if (offset > -1) {
                return offset;
            }
        }
        return -1;
    },

    _computeLayerOffset: function () {
        this.layerOffset = {};

        for (var i = 0; i < this.query.length; i += 2) {
            var layer = this.query[i];

            if (this.query[i + 1] === '_') {
                this.layerOffset[layer] = -1;
            } else {
                this.layerOffset[layer] = this.visModel.numberOfLayers() - 1 -
                    this.visModel.get('metadata').offset[this.query.substr(i, 2)];
            }
        }
    },

    _computeCompositeInfo: function (data) {
        var composite = data.json['pixel-order'].split('+'),
            count = composite.length;
        /*jshint -W016 */
        while (count--) {
            var str = composite[count];
            if (str[0] === '@') {
                composite[count] = Number(str.substr(1));
            } else if (!_.has(this.orderMapping, str)) {
                this.orderMapping[str] = this._computeOffset(str);
            }
        }

        data.composite = composite;
    },

    /**
     * Computes the composite image and writes it into the composite buffer.
     * @param data The payload from the composite image manager c:data.ready
     * callback. This will write computed composite data back into that
     * cache entry so it won't have to recompute it.
     */
    _writeCompositeBuffer: function (data) {
        if (!_.has(data, 'composite')) {
            this._computeCompositeInfo(data);
        }

        var renderCanvas = this.$('.c-vis-render-canvas')[0],
            compositeCanvas = this.$('.c-vis-composite-buffer')[0],
            spriteCanvas = this.$('.c-vis-spritesheet-buffer')[0],
            dim = this.visModel.imageDimensions(),
            spritesheetDim = this.visModel.spritesheetDimensions(),
            spriteCtx = spriteCanvas.getContext('2d'),
            compositeCtx = compositeCanvas.getContext('2d');

        $(spriteCanvas).attr({
            width: spritesheetDim[0],
            height: spritesheetDim[1]
        });
        $(compositeCanvas).attr({
            width: dim[0],
            height: dim[1]
        });

        // Fill full spritesheet buffer with raw image data
        spriteCtx.drawImage(data.image, 0, 0);

        var pixelBuffer = spriteCtx.getImageData(0, 0,
                  spritesheetDim[0], spritesheetDim[1]).data,
            frontBuffer,
            pixelIdx = 0;

        // Fill the background if backgroundColor is specified
        if (this.backgroundColor) {
            compositeCtx.fillStyle = this.backgroundColor;
            compositeCtx.fillRect(0, 0, dim[0], dim[1]);
            frontBuffer = compositeCtx.getImageData(0, 0, dim[0], dim[1]);
        } else { // Otherwise use the bottom spritesheet image as a background
            frontBuffer = spriteCtx.getImageData(
                0, (this.visModel.numberOfLayers() - 1) * dim[1], dim[0], dim[1]);
        }

        var frontPixels = frontBuffer.data;

        for (var i = 0; i < data.composite.length; i += 1) {
            var order = data.composite[i];
            if (order > 0) {
                pixelIdx += order;
            } else {
                var offset = this.orderMapping[order];

                if (offset > -1) {
                    var localIdx = 4 * pixelIdx;
                    offset *= dim[0] * dim[1] * 4;
                    offset += localIdx;
                    frontPixels[localIdx] = pixelBuffer[offset];
                    frontPixels[localIdx + 1] = pixelBuffer[offset + 1];
                    frontPixels[localIdx + 2] = pixelBuffer[offset + 2];
                    frontPixels[localIdx + 3] = 255;
                }
                pixelIdx += 1;
            }
        }

        // Draw buffer to composite canvas
        compositeCtx.putImageData(frontBuffer, 0, 0);
    },

    /**
     * Call this after data has been successfully rendered onto the composite
     * canvas, and it will draw it with the correct scale, zoom, and center
     * onto the render canvas.
     */
    drawImage: function () {
        var renderCanvas = this.$('.c-vis-render-canvas')[0],
            compositeCanvas = this.$('.c-vis-composite-buffer')[0],
            w = this.$el.parent().width(),
            h = this.$el.parent().height(),
            iw = compositeCanvas.width,
            ih = compositeCanvas.height;

        $(renderCanvas).attr({
            width: w,
            height: h
        });
        renderCanvas.getContext('2d').clearRect(0, 0, w, h);

        var tw = Math.floor(iw * this.zoomLevel),
        th = Math.floor(ih * this.zoomLevel),
        dx = (tw > w) ? (tw - w) : (w - tw),
        dy = (th > h) ? (th - h) : (h - th),
        centerBounds = [(w - dx) / 2, (h - dy) / 2, (w + dx) / 2, (h + dy) / 2];

        if (this.drawingCenter[0] < centerBounds[0] ||
            this.drawingCenter[0] > centerBounds[2] ||
            this.drawingCenter[1] < centerBounds[1] ||
            this.drawingCenter[1] > centerBounds[3]) {
            this.drawingCenter = [
                Math.min(Math.max(this.drawingCenter[0], centerBounds[0]), centerBounds[2]),
                Math.min(Math.max(this.drawingCenter[1], centerBounds[1]), centerBounds[3])
            ];

        }
        var tx = this.drawingCenter[0] - (tw / 2),
            ty = this.drawingCenter[1] - (th / 2);

        renderCanvas.getContext('2d').drawImage(
            compositeCanvas,
            0,   0, iw, ih,  // Source image   [Location,Size]
            tx, ty, tw, th); // Target drawing [Location,Size]
    },

    /**
     * Reset the zoom level and drawing center such that the image is
     * centered and zoomed to fit within the parent container.
     */
    resetCamera: function () {
        var w = this.$el.parent().width(),
            h = this.$el.parent().height(),
            iw = this.$('.c-vis-composite-buffer').width(),
            ih = this.$('.c-vis-composite-buffer').height();

        this.zoomLevel = Math.min(w / iw, h / ih);
        this.drawingCenter = [w / 2, h / 2];
    },

    /**
     * Change the viewpoint to show a different image.
     * @param viewpoint An object containing "time", "phi", and "theta" keys. If you
     * do not pass this, simply renders the current this.viewpoint value.
     * @return this, for chainability
     */
    showViewpoint: function (viewpoint) {
        if (viewpoint) {
            this.viewpoint = viewpoint;
        }
        this.compositeManager.updateViewpoint(this.viewpoint);

        return this;
    },

    /**
     * Maps an [x, y] value relative to the canvas element to an [x, y] value
     * relative to the image being rendered on the canvas.
     * @param coords 2-length list representing [x, y] offset into the canvas
     * element.
     * @returns the corresponding [x, y] value of the image being rendered on
     * the canvas, respecting zoom level and drawing center, or null if the
     * input coordinates are on a part of the canvas outside of the image render
     * bounds. If not null, this will be a value bounded in each dimension by
     * the length of the composited image in that dimension.
     */
    mapToImageCoordinates: function (coords) {
        // TODO
    }
});
