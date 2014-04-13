// wiki.js

var
    _ = require('lodash'),
    async = require('async'),
    api = require('../api'),
    db = require('../db'),
    utils = require('./_utils'),
    images = require('./_images'),
    constants = require('../constants');

var
    attachmentsApi = require('./attachmentApi'),
    checkAttachment = attachmentsApi.checkAttachment,
    createAttachmentTaskInTx = attachmentsApi.createAttachmentTaskInTx;

var
    User = db.user,
    Wiki = db.wiki,
    WikiPage = db.wikipage,
    Text = db.text,
    warp = db.warp,
    next_id = db.next_id;

function getWikis(callback) {
    Wiki.findAll(function(err, entities) {
        if (err) {
            return callback(err);
        }
        return callback(null, {
            wikis: entities
        });
    });
}

function getWiki(id, tx, callback) {
    if (arguments.length===2) {
        callback = tx;
        tx = undefined;
    }
    Wiki.find(id, function(err, entity) {
        if (err) {
            return callback(err);
        }
        if (entity===null) {
            return callback(api.notFound('Wiki'));
        }
        callback(null, entity);
    });
}

function getWikiWithContent(id, tx, callback) {
    if (arguments.length===2) {
        callback = tx;
        tx = undefined;
    }
    getWiki(id, tx, function(err, entity) {
        if (err) {
            return callback(err);
        }
        Text.find(entity.content_id, function(err, text) {
            if (err) {
                return callback(err);
            }
            if (text===null) {
                return callback(api.notFound('Text'));
            }
            entity.content = text.value;
            callback(null, entity);
        });
    });
}

function treeIterate(nodes, root) {
    var rid = root.id;
    root.children = [];
    var removes = [];
    for (nid in nodes) {
        node = nodes[nid];
        if (node.parent_id===rid) {
            root.children.push(node);
            removes.push(nid);
        }
    }
    for (key in removes) {
        delete nodes[key];
    }
    if (root.children.length>0) {
        root.children.sort(function(n1, n2) {
            return n1.display_order < n2.display_order ? (-1) : 1;
        });
        for (ch in root.children) {
            treeIterate(nodes, ch);
        }
    }
}

function getWikiPages(wiki_id, returnAsDict, callback) {
    if (arguments.length===2) {
        callback = returnAsDict;
        returnAsDict = false;
    }
    WikiPage.findAll({
        where: 'wiki_id=?',
        params: [wiki_id]
    }, function(err, pages) {
        if (err) {
            return callback(err);
        }
        var pdict = {};
        pages.forEach(function(p) {
            pdict[p.id] = p;
        });
        if (returnAsDict) {
            return pdict;
        }
        var proot = { id: '' };
        treeIterate(pdict, proot);
        return proot.children;
    });
}

function createWikiPage(wp, callback) {
    var content = wp.content;
    var doCreateWikiPage = function() {
        warp.transaction(function(err, tx) {
            if (err) {
                return callback(err);
            }
            var
                wp_id = next_id(),
                content_id = next_id();
            async.waterfall([
                // create text:
                function(callback) {
                    Text.create({
                        id: content_id,
                        ref_id: wp_id,
                        value: content
                    }, tx, callback);
                },
                // count:
                function(text, callback) {
                    warp.queryNumber('select count(id) from wikipages where wiki_id=? and parent_id=?', [wp.wiki_id, wp.parent_id], tx, callback);
                },
                // create wiki:
                function(num, callback) {
                    wp.id = wp_id;
                    wp.content_id = content_id;
                    wp.display_order = num;
                    WikiPage.create(wp, tx, callback);
                }
            ], function(err, result) {
                tx.done(err, function(err) {
                    if (err) {
                        return callback(err);
                    }
                    result.content = content;
                    callback(null, result);
                });
            });
        });
    };
    if (wp.parent_id) {
        getWikiPage(wp.parent_id, function(err, entity) {
            if (err) {
                return callback(err);
            }
            if (wp.wiki_id!==entity.wiki_id) {
                return callback(api.invalidParam('parent_id'));
            }
            doCreateWikiPage();
        });
    }
    doCreateWikiPage();
}

// get wiki page by id:
function getWikiPage(id, tx, callback) {
    if (arguments.length===2) {
        callback = tx;
        tx = undefined;
    }
    WikiPage.find(id, function(err, entity) {
        if (err) {
            return callback(err);
        }
        if (entity===null) {
            return callback(api.notFound('WikiPage'));
        }
        callback(null, entity);
    });
}

// get wiki page by id, with content attached:
function getWikiPageWithContent(id, tx, callback) {
    if (arguments.length===2) {
        callback = tx;
        tx = undefined;
    }
    getWikiPage(id, tx, function(err, entity) {
        if (err) {
            return callback(err);
        }
        Text.find(entity.content_id, function(err, text) {
            if (err) {
                return callback(err);
            }
            if (text===null) {
                return callback(api.notFound('WikiPage'));
            }
            entity.content = text.value;
            callback(null, entity);
        });
    });
}

exports = module.exports = {

    getWiki: getWiki,

    getWikis: getWikis,

    getWikiPages: getWikiPages,

    getWikiWithContent: getWikiWithContent,

    getWikiPage: getWikiPage,

    getWikiPageWithContent: getWikiPageWithContent,

    'GET /api/wikis/:id': function(req, res, next) {
        getWikiWithContent(req.params.id, function(err, entity) {
            if (err) {
                return next(err);
            }
            return res.send(entity);
        });
    },

    'GET /api/wikis': function(req, res, next) {
        getWikis(function(err, entities) {
            if (err) {
                return next(err);
            }
            return res.send(entities);
        });
    },

    'POST /api/wikis': function(req, res, next) {
        /**
         * Create a new wiki.
         * 
         * @return {object} The created wiki object.
         */
        if (utils.isForbidden(req, constants.ROLE_EDITOR)) {
            return next(api.notAllowed('Permission denied.'));
        }
        try {
            var
                name = utils.getRequiredParam('name', req),
                description = utils.getRequiredParam('description', req),
                content = utils.getRequiredParam('content', req);
        }
        catch (e) {
            return next(e);
        }
        var tags = utils.formatTags(utils.getParam('tags', '', req));

        var file = req.files && req.files.file;

        var content_id = next_id();
        var wiki_id = next_id();

        var fnCreate = function(fileObject) {
            warp.transaction(function(err, tx) {
                if (err) {
                    return next(err);
                }
                async.waterfall([
                    // create text:
                    function(callback) {
                        Text.create({
                            id: content_id,
                            ref_id: wiki_id,
                            value: content
                        }, tx, callback);
                    },
                    // create attachment:
                    function(text, callback) {
                        if (fileObject) {
                            var fn = createAttachmentTaskInTx(fileObject, tx, req.user.id);
                            return fn(callback);
                        }
                        callback(null, null);
                    },
                    // create wiki:
                    function(atta, callback) {
                        Wiki.create({
                            id: wiki_id,
                            cover_id: atta===null ? '' : atta.id,
                            content_id: content_id,
                            name: name,
                            tags: tags,
                            description: description
                        }, tx, callback);
                    }
                ], function(err, result) {
                    tx.done(err, function(err) {
                        if (err) {
                            return next(err);
                        }
                        result.content = content;
                        return res.send(result);
                    });
                });
            });
        };

        if (file) {
            return checkAttachment(file, true, function(err, attachFileObject) {
                if (err) {
                    return next(err);
                }
                // override name:
                attachFileObject.name = name;
                fnCreate(attachFileObject);
            });
        }
        return fnCreate(null);
    },

    'POST /api/wikis/:id/wikipages': function(req, res, next) {
        /**
         * Create a wiki page.
         * 
         * @return {object} The created wiki page object.
         */
        try {
            var
                name = utils.getRequiredParam('name', req),
                content = utils.getRequiredParam('content', req),
                parent_id = utils.getRequiredParam('parent_id', req);
        }
        catch (e) {
            return next(e);
        }
        getWiki(req.params.id, function(err, wiki) {
            if (err) {
                return next(err);
            }
            createWikiPage({
                wiki_id: wiki.id,
                parent_id: parent_id==='ROOT' ? '' : parent_id,
                name: name,
                content: content
            }, function(err, wikipage) {
                if (err) {
                    return next(err);
                }
                return res.send(wikipage);
            });
        });
    },

    'GET /api/wikis/:id/wikipages': function(req, res, next) {
        //
    },

    'POST /api/wikis/:id': function(req, res, next) {
        /**
         * Update a wiki.
         * 
         * @return {object} The updated wiki object.
         */
        if (utils.isForbidden(req, constants.ROLE_EDITOR)) {
            return next(api.notAllowed('Permission denied.'));
        }
        var name = utils.getParam('name', req),
            description = utils.getParam('description', req),
            tags = utils.getParam('tags', req),
            content = utils.getParam('content', req);

        if (name!==null && name==='') {
            return next(api.invalidParam('name'));
        }
        if (description!==null && description==='') {
            return next(api.invalidParam('description'));
        }
        if (content!==null && content==='') {
            return next(api.invalidParam('content'));
        }
        if (tags!==null) {
            tags = utils.formatTags(tags);
        }

        var file = req.files && req.files.file;

        var fnUpdate = function(fileObject) {
            warp.transaction(function(err, tx) {
                if (err) {
                    return next(err);
                }
                async.waterfall([
                    // query wiki:
                    function(callback) {
                        Wiki.find(req.params.id, tx, callback);
                    },
                    // update text?
                    function(wiki, callback) {
                        if (wiki===null) {
                            return callback(api.notFound('Wiki'));
                        }
                        if (content===null) {
                            return callback(null, wiki);
                        }
                        var content_id = next_id();
                        Text.create({
                            id: content_id,
                            ref_id: wiki.id,
                            value: content
                        }, tx, function(err, text) {
                            if (err) {
                                return callback(err);
                            }
                            wiki.content_id = content_id;
                            callback(null, wiki);
                        });
                    },
                    // update cover?
                    function(wiki, callback) {
                        if (fileObject) {
                            var fn = createAttachmentTaskInTx(fileObject, tx, req.user.id);
                            return fn(function(err, atta) {
                                if (err) {
                                    return callback(err);
                                }
                                wiki.cover_id = atta.id;
                                callback(null, wiki);
                            });
                        }
                        callback(null, wiki);
                    },
                    // update wiki:
                    function(wiki, callback) {
                        if (name!==null) {
                            wiki.name = name;
                        }
                        if (description!==null) {
                            wiki.description = description;
                        }
                        if (tags!==null) {
                            wiki.tags = tags;
                        }
                        wiki.update(tx, callback);
                    }
                ], function(err, result) {
                    tx.done(err, function(err) {
                        if (err) {
                            return next(err);
                        }
                        if (content!==null) {
                            result.content = content;
                            return res.send(result);
                        }
                        Text.find(result.content_id, function(err, text) {
                            if (err) {
                                return next(err);
                            }
                            result.content = text.value;
                            return res.send(result);
                        });
                    });
                });
            });
        };

        if (file) {
            return checkAttachment(file, true, function(err, attachFileObject) {
                if (err) {
                    return next(err);
                }
                // override name:
                attachFileObject.name = name;
                fnUpdate(attachFileObject);
            });
        }
        return fnUpdate(null);
    },

    'POST /api/wikis/wikipages/:wpid/move/:targetId': function(req, res, next) {
        /**
         * Move a wikipage to another node.
         * 
         * @return {object} The moved wiki object.
         */
        if (utils.isForbidden(req, constants.ROLE_EDITOR)) {
            return next(api.notAllowed('Permission denied.'));
        }
        var
            wpid = req.params.wpid,
            targetId = req.params.targetId;
        try {
            var index = parseInt(utils.getRequiredParam('index', req));
        }
        catch (e) {
            return next(e);
        }
        if (isNaN(index) || index < 0) {
            return next(api.invalidParam('index'));
        }
        // get the 2 pages:
        var wiki, movingPage, parentPage, allPages;
        async.waterfall([
            function(callback) {
                getWikiPage(wpid, callback);
            },
            function(wp, callback) {
                movingPage = wp;
                getWiki(movingPage.wiki_id, callback);
            },
            function(w, callback) {
                wiki = w;
                if (targetId==='ROOT') {
                    return callback(null, null);
                }
                getWikiPage(targetId, callback);
            },
            function(wp, callback) {
                parentPage = wp;
                if (parentPage!==null && parentPage.wiki_id!==wiki.id) {
                    return callback(api.invalidParam('targetId'));
                }
                callback(null, null);
            },
            function(prev, callback) {
                getWikiPages(wiki.id, true, callback);
            },
            function(all, callback) {
                allPages = all;
                // check to prevent recursive:
                if (parentPage!==null) {
                    var p = parentPage;
                    while (p.parent_id !== '') {
                        if (p.parent_id===movingPage.id) {
                            return callback(api.resourceConflictError('Will cause recursive.'));
                        }
                        p = allPages[p.parent_id];
                    }
                }
                // check ok:
                callback(null, null);
            }
        ], function(err, r) {
            if (err) {
                return next(err);
            }
            // get current children:
            var parentId = parentPage===null ? '' : parentPage.id;
            var L = [];
            _.each(allPages, function(p, pid) {
                if (p.parent_id===parentId && p.id!==movingPage.id) {
                    L.push(p);
                }
            });
            if (index > L.length) {
                return next(api.invalidParam('index'));
            }
            L.sort(function(p1, p2) {
                return p1.display_order < p2.display_order ? (-1) : 1;
            });
            L.splice(index, 0, movingPage);
            // update display order and movingPage:
            warp.transaction(function(err, tx) {
                var tasks = [];
                _.each(L, function(p, index) {
                    warp.update('update wikipages set display_order=? where id=?', [index, p.id], tx, callback);
                });
                tasks.push(function(callback) {
                    movingPage.parent_id = parentId;
                    movingPage.update(['parent_id', 'updated_at', 'version'], tx, callback);
                });
                async.serial(tasks, function(err, results) {
                    tx.done(err, function(err) {
                        if (err) {
                            return next(err);
                        }
                        return res.send(results.pop());
                    });
                });
            });
        });
    },

    'POST /api/wikis/:id/delete': function(req, res, next) {
        /**
         * Delete a wiki by its id.
         * 
         * @param {string} :id - The id of the wiki.
         * @return {object} Results contains deleted id. e.g. {"id": "12345"}
         */
        if (utils.isForbidden(req, constants.ROLE_EDITOR)) {
            return next(api.notAllowed('Permission denied.'));
        }
        warp.transaction(function(err, tx) {
            if (err) {
                return next(err);
            }
            async.waterfall([
                function(callback) {
                    Wiki.find(req.params.id, tx, callback);
                },
                function(wiki, callback) {
                    if (wiki===null) {
                        return callback(api.notFound('Wiki'));
                    }
                    // check wiki pages:
                    WikiPage.findNumber({
                        select: 'count(id)',
                        where: 'wiki_id=?',
                        params: [wiki.id]
                    }, tx, function(err, num) {
                        if (err) {
                            return callback(err);
                        }
                        if (num > 0) {
                            return callback(api.resourceConflictError('Wiki is not empty.'));
                        }
                        callback(null, wiki);
                    });
                },
                function(wiki, callback) {
                    wiki.destroy(tx, callback);
                },
                function(r, callback) {
                    // delete all texts:
                    warp.update('delete from texts where ref_id=?', [req.params.id], tx, callback);
                }
            ], function(err, result) {
                tx.done(err, function(err) {
                    if (err) {
                        return next(err);
                    }
                    res.send({ id: req.params.id });
                });
            });
        });
    }
}
