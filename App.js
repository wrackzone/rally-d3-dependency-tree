var app = null;

Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    items : [ 
        { 
            layout:'column',
            items : [
                {
                    margin : "5 20 5 20",
                    width : 400,
                    id:'cboFilter',
                    xtype:'combobox',
                    fieldLabel:'Successor',
                    displayField:'name',
                    valueField:'id',
                    queryMode:'local',
                    listeners : {
                        scope : this,
                        select : function(combo,records,eOpts) {
                            app.filterSuccessor(combo,records,eOpts);
                        }
                    }
                },
                { itemId : "exportLink", margin : "5 20 5 20"}
            ]
        }
    ],

    filterSuccessor : function(combo,records,eOpts) {      
        var selected = records[0];
        var root = _.find(app.nodes,function(node) { return node.id === selected.get("id");});

        var newNodes = [];
        var newLinks = [];

        var walkTheLine = function(root, newNodes, newLinks) {
            if (_.find(newNodes,function(n){return n.id===root.id;})===undefined)
                newNodes.push(root);
            var links = _.filter(app.links,function(link) { return link.source.id === root.id;});
            _.each(links,function(link){ 
                newLinks.push(link);
                walkTheLine(link.target,newNodes,newLinks);
            });
        }

        walkTheLine( root, newNodes, newLinks);

        // console.log("filtered:",root,newNodes,newLinks);

        app._createDagreGraph(newNodes,newLinks,function(err,nodes,links) {
            // console.log("selected:",nodes,links);
        })
    },

    launch: function() {
        app = this;
        app.filterItems = [];
        app.filterStore = Ext.create('Ext.data.Store',{
            fields:['id','name'],
            data: app.filterItems
        });
        app.down("#cboFilter").bindStore(app.filterStore);

        
        app.project = app.getContext().getProject();
        // console.log("project",app.project);

        app.showFilter = app.getSetting('showFilter') === true;
        app.hideAccepted = app.getSetting('hideAccepted') === true;
        app.truncateNameTo = app.getSetting('truncateNameTo') > 0 ? parseInt(app.getSetting('truncateNameTo')) : 0;
        
        if (!app.showFilter) {
            app.down("#cboFilter").hide();
        }

        // console.log("hideAccepted",app.hideAccepted);
        app.myMask = new Ext.LoadMask(Ext.getBody(), {msg:"Please wait..."});
        app.myMask.show();

        async.waterfall([ 
                          this.getDependencySnapshots,
                          this.findMissingSnapshots,
                          this.addChildStoryInformation,
                          this.getProjectInformation,
                          this.cleanUpSnapshots,
                          this.getIterationInformation,
                          this._createGraph,
                          this._setFilterNodes,
                          this._createNodeList,
                          this._createNodeStatus,
                          this._createDagreGraph,
                          this._createGraphViz
                          ], 
            function(err,nodes,links){
                app.myMask.hide();
                // console.log("nodes",nodes); 
                // console.log("links",links); 
                app.nodes = nodes;
                app.links = links;
            }
        );
    },

    config: {
        defaultSettings: {
            showFilter     : false,
            hideAccepted   : true,
            showExportLink : true,
            truncateNameTo : "0"
        }
    },

    getSettingsFields: function() {
        return [
            {
                name: 'showFilter',
                xtype: 'rallycheckboxfield',
                label : "Show Successor Filter"
            },

            {
                name: 'hideAccepted',
                xtype: 'rallycheckboxfield',
                label : "True to hide accepted stories"
            },
            {
                name: 'truncateNameTo',
                xtype: 'rallytextfield',
                label : "Truncate the name to specified number of characters"
            },
            {
                name: 'showExportLink',
                xtype: 'rallycheckboxfield',
                label : "Show Link to Export (dot) file"
            }
        ];
    },

    getProjectInformation : function( snapshots, callback) {

        var projects = _.compact(_.uniq(_.map( snapshots, function(s) { return s.get("Project"); })));
        async.map( projects, app.readProject, function(err,results) {
            app.projects = _.compact(_.map(results,function(r) { return r[0];}));
            callback(null,snapshots);
        });
    },

    cleanUpSnapshots : function( snapshots, callback) {

        console.log("unfiltered snapshots:",snapshots.length);
        var snaps = _.filter(snapshots,function(snapshot) {
            // make sure the project for the snapshot exists
            var project = _.find(app.projects, function(p) { 
                return snapshot.get("Project") === p.get("ObjectID");
            });

            return !(_.isUndefined(project)||_.isNull(project));
        });
        // console.log("filtered snapshots:",snaps.length);

        callback(null,snaps);

    },

    getIterationInformation : function( snapshots, callback) {

        // also check for epic iterations
        var epicIterations = _.uniq( _.flatten(_.map(snapshots, function(s) {
            return _.map(s.get("LeafNodes"),function(leaf) { 
                return(leaf.get("Iteration"));
            })
        })));

        var iterations = _.map( snapshots, function(s) { return s.get("Iteration"); });

        iterations = _.union(iterations,epicIterations);

        console.log("iterations",iterations);

        var readIteration = function( iid, callback) {
            var config = { 
                model : "Iteration", 
                fetch : ['Name','ObjectID','StartDate','EndDate'], 
                filters : [{property : "ObjectID", operator : "=", value : iid}],
                context : { project : null}
            };
            app.wsapiQuery(config,callback);
        };

        async.map( iterations, readIteration, function(err,results) {
            app.iterations = _.map(results,function(r) { return r[0];});
            app.iterations = _.reject(app.iterations,function(i) {return (i==="")||_.isUndefined(i);});
            console.log("iterations", app.iterations);
            callback(null,snapshots);
        });
    },

    readProject : function( pid, callback) {

        var config = { model : "Project", 
                       fetch : ['Name','ObjectID','State'], 
                       filters : [{property : "ObjectID", operator : "=", value : pid}]};
        app.wsapiQuery(config,callback);

    },

    wsapiQuery : function( config , callback ) {

        var storeConfig = {
            autoLoad : true,
            limit : "Infinity",
            model : config.model,
            fetch : config.fetch,
            filters : config.filters,
            listeners : {
                scope : this,
                load : function(store, data) {
                    callback(null,data);
                }
            }
        };
        if (!_.isUndefined(config.context)) {
            storeConfig.context = config.context;
        }

        Ext.create('Rally.data.WsapiDataStore', storeConfig);
    },

    // iterates the snapshots, checks predecessors to see if they are in the list
    // if not returned as an array to be read from rally

    getMissingSnapshots : function(snapshots) {
        var all = _.pluck(snapshots, function(s) { return s.get("ObjectID");});
        var missing = [];
        _.each(snapshots,function(s){
            var pr = s.get("Predecessors");
            var su = s.get("Successors");
            if ( _.isArray(pr)) {
                missing.push(_.difference( pr, all));
            }
            if ( _.isArray(su)) {
                // console.log(_.difference( pr, all));
            }
        });
        return _.uniq(_.flatten(missing));
    },
    
    findMissingSnapshots : function( snapshots, callback ) {

        var missing = app.getMissingSnapshots(snapshots);
        console.log("missing:",missing);

        var config = {};
        config.fetch = ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name','Project','Iteration','FormattedID','Children'];
        config.hydrate =  ['_TypeHierarchy','ScheduleState'];
        config.find = {
            'ObjectID' : { "$in" : missing },
            '__At' : 'current',
            'Project' : { "$exists" : true},
            'Project' : { "$ne" : null}
        };

        async.map([config],app._snapshotQuery,function(err,results) {
            // console.log("missing snapshots:",results[0]);
            _.each(results[0],function(s) {
                snapshots.push(s);
            });
            // callback(null,snapshots);
            if (app.getMissingSnapshots(snapshots).length>0)
                app.findMissingSnapshots(snapshots,callback);
            else
                callback(null,snapshots);
        });

    },

    // if a snapshot represents a parent story this will add key information, specifically the 
    // iteration date of the last child.
    addChildStoryInformation : function( snapshots, callback ) {

        var epicSnapshots = _.filter(snapshots,function(s) {
            return s.get("Children").length > 0
        });

        console.log("epics",epicSnapshots);

        async.map( epicSnapshots, app.leafNodeSnapshots,function(err,results) {

            console.log("epic results:",results);
            _.each( results, function( leafNodes,i) {
                epicSnapshots[i].set("LeafNodes",leafNodes);
            });

            callback(null,snapshots);

        });

        

    },

    leafNodeSnapshots : function( epicSnapshot, callback ) {

        var config = {};

        config.fetch = ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name','Project','Iteration','FormattedID','Children'];
        config.hydrate =  ['_TypeHierarchy','ScheduleState'];
        config.find = {         
            '_TypeHierarchy' : { "$in" : ["HierarchicalRequirement"]},
            '_ItemHierarchy' : { "$in" : [epicSnapshot.get("ObjectID")]},
            '_ProjectHierarchy' : { "$in": [app.getContext().getProject().ObjectID]}, 
            'Children' : null,
            '__At' : 'current',
        };

        // hide accepted stories
        if (app.hideAccepted)
            config.find['ScheduleState'] = { "$ne" : "Accepted" };

        async.map([config],app._snapshotQuery,function(error,results) {
            callback(null,results[0]);
        });
        
    },

    
    getDependencySnapshots : function( callback ) {

        var that = this;
        var config = {};

        config.fetch = ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name','Project','Iteration','FormattedID','Children'];
        config.hydrate =  ['_TypeHierarchy','ScheduleState'];
        config.find = {
            '_TypeHierarchy' : { "$in" : ["HierarchicalRequirement"]} ,
            '_ProjectHierarchy' : { "$in": [app.getContext().getProject().ObjectID] } , 
            '__At' : 'current',
            '$or' : [   
                {"Predecessors" : { "$exists" : true }}
                // {"Successors" : { "$exists" : true }},
            ]
        };

        // hide accepted stories
        if (app.hideAccepted)
            config.find['ScheduleState'] = { "$ne" : "Accepted" };

        async.map([config],app._snapshotQuery,function(error,results) {
            callback(null,results[0]);
        });
        
        
    },

    _snapshotQuery : function( config ,callback) {

        var storeConfig = {
            find    : config.find,
            fetch   : config.fetch,
            hydrate : config.hydrate,
            autoLoad : true,
            pageSize : 10000,
            limit    : 'Infinity',
            listeners : {
                scope : this,
                load  : function(store,snapshots,success) {
                    // console.log("snapshots:",snapshots.length);
                    callback(null,snapshots);
                }
            }
        };
        var snapshotStore = Ext.create('Rally.data.lookback.SnapshotStore', storeConfig);

    },

    _linkFromSnapshot : function(snapshot) {
        var tpl = Ext.create('Ext.Template', "https://rally1.rallydev.com/#/detail/userstory/{objectid}", { compiled : true } );
        return tpl.apply({objectid:snapshot.get("ObjectID")});
    },

    _anchor : function(ref, content) {

        var tpl = Ext.create('Ext.Template', 
            "<a href='{ref}' target='_blank'>{content}</a>", { compiled : true } );
        return tpl.apply({ref:ref,content:content});

    },

    _renderNodeTemplate : function( node ) {

        var snapshot = node.snapshot;
        var id_style = snapshot.get("ScheduleState")==="Accepted" ? "accepted-story" : "";

        var name = app.truncateNameTo > 0 ? node.snapshot.get("Name").substring(0,app.truncateNameTo) : node.snapshot.get("Name");
        var project = _.find(app.projects, function(p) { 
            return node.snapshot.get("Project") === p.get("ObjectID");
        });

        var projectName = project ? project.get("Name") : "Not Found!";
        var state_class = node.snapshot.get("Blocked") === true ? "status-blocked" : "";
        var project_class = project.get("ObjectID") !== app.project.ObjectID ?
            "other-project" : "";

        var date_class = "";
        var iterationEndDate = app._iterationEndDate(node.snapshot.get("Iteration"));
        iterationEndDate = iterationEndDate ? moment(iterationEndDate).format("MM/DD/YYYY") : "";
        if (iterationEndDate) {
            if (node.status.length > 0)
                date_class = node.status[0].status;
        }

        var childCount = node.snapshot.get('Children').length > 0 ? " (" + node.snapshot.get('Children').length + ")" : "";

        var tpl = Ext.create('Ext.Template', 
        "<table class='graph-node'>" +
            "<tr><td><a class='{id_style}' href='{id_ref}' target='_blank'>{id}</a> : {name}<span class='{state_class}'> [{state}] </span><span>{child_count}</span></td></tr>" +
            "<tr><td>Project:<span class='{project_class}'>{project}</span></td></tr>" +
            "<tr><td><span class='{date_class}'>{date}</span></td></tr>" +
        "</tr></table>", { compiled : true } );

        return tpl.apply( {
            id_style : id_style,
            id_ref : app._linkFromSnapshot(snapshot),
            id : snapshot.get("FormattedID"),
            name : name,
            state : node.snapshot.get("ScheduleState").substring(0,1),
            state_class : state_class,
            project_class : project_class,
            project : projectName,
            date_class : date_class,
            date : iterationEndDate,
            child_count : childCount
        });


    },
    
    _createDagreGraph : function( nodes, links,callback ) {

        app.myMask.hide();
        var g = new dagre.Digraph();

        _.each(nodes, function(node){
            g.addNode(node.id, { label : app._renderNodeTemplate(node)});
        });

        _.each(links, function(link){
            g.addEdge(null, link.source.id, link.target.id, {label:""});
        });

        if (!_.isUndefined(app.x) && !_.isNull(app.x)) {
            app.x.destroy();
        }

        app.x = Ext.widget('container',{
            autoShow: true ,shadow: false,title: "",resizable: false,margin: 10
            ,html: '<div id="demo-container" class="div-container"></div>'
            ,listeners: {
                resize: function(panel) {
                },
                afterrender : function(panel) {
                    var svg = d3.select("#demo-container").append("div").append("svg")
                    .attr("class","svg")
                    .attr("transform","translate(10,10)");

                    var renderer = new dagreD3.Renderer();
                    renderer.run(g, svg); 
                    callback(null,nodes,links);
                }
            }
        });
        app.add(app.x);
        callback(null,nodes,links);

    },

    _formatGraphVizNode : function (node) {

        var name = app.truncateNameTo > 0 ? node.snapshot.get("Name").substring(0,app.truncateNameTo) : node.snapshot.get("Name");

        // replace & with + chars from name as they cause a problem when using the 'dot' command.
        name = name.replace(/\&/g,"+");

        // example : US15036 [label=<<TABLE><TR><TD>US15036:Create C2P test cases for th<br/>e reviewed + approved claim scenari<br/>os[A]</TD></TR><TR><TD>Project:: <FONT color='blue'>CNG End-to-End Test</FONT> </TD></TR><TR><TD><FONT color='green'>(9/16/2011)</FONT></TD></TR></TABLE>>]
        var project = _.find(app.projects, function(p) { 
            return node.snapshot.get("Project") === p.get("ObjectID");
        });

        if (_.isUndefined(project)||_.isNull(project)) {
            console.log("problem with project for:",node);
        }

        var iterationEndDate = app._iterationEndDate(node.snapshot.get("Iteration"));

        var g = node.snapshot.get("FormattedID") + " ";
        g = g + " [label=<";
        g = g + "<TABLE>";
        // row 1
        g = g + "<TR>";
        g = g + "<TD>";
        // g = g + node.snapshot.get("FormattedID") + ":" + node.snapshot.get("Name") + " [" + node.snapshot.get("ScheduleState").substring(0,1) + "] ";
        g = g + node.snapshot.get("FormattedID") + ":" + name + " [" + node.snapshot.get("ScheduleState").substring(0,1) + "] ";
        g = g + "</TD>";
        g = g + "</TR>";
        // row 2
        g = g + "<TR>";
        g = g + "<TD>";
        g = g + "Project:" + project.get("Name");
        g = g + "</TD>";
        g = g + "</TR>";
        // row 3
        g = g + "<TR>";
        g = g + "<TD>";
        g = g + (iterationEndDate ? moment(iterationEndDate).format("MM/DD/YYYY") : "");
        g = g + "</TD>";
        g = g + "</TR>";

        g = g + "</TABLE>";
        g = g + " >]\n";

        return g;
    },

    _createGraphViz : function( nodes, links, callback ) {

        var gv = "digraph G {\n     orientation=portrait\n    node [shape=plaintext, fontsize=14]\n";

        _.each(nodes,function(node) {
            gv = gv + app._formatGraphVizNode(node);
        });

        var gvLinks = "";

        _.each(links,function(link) {
            gvLinks = gvLinks + link.source.snapshot.get("FormattedID") + 
                " -> " + 
                link.target.snapshot.get("FormattedID") + 
                ";\n";
        });

        gv = gv + gvLinks + " }";

        app.gv = gv;

        if (app.getSetting('showExportLink') === true) {
            var link = app.down("#exportLink");
            link.update(app._createLink(app.gv));
            // app.add(link);
        }

        callback(null,nodes,links);

    },

    _createLink : function(gvString) {
        return "<a href='data:text/dot;charset=utf8," + encodeURIComponent(gvString) + "' download='export.dot'>Click to download dot file</a>";
    },

    _createGraph : function( snapshots, callback ) {
        var that = this;
        var p = _.filter(snapshots,function(rec) { return _.isArray(rec.get("Predecessors"));});
        var s = _.filter(snapshots,function(rec) { return _.isArray(rec.get("Successors"));});

        // create the set of node elements
        var nodes = _.map( snapshots, function(snap) {
            if (_.isArray(snap.get("Predecessors"))||_.isArray(snap.get("Successors"))) {
                return { id : snap.get("ObjectID"), snapshot : snap };
            } else {
                return null;
            }
        });
        nodes = _.compact(nodes);
        var links = [];
        _.each(nodes, function(node) {
            _.each(node.snapshot.get("Predecessors"), function(pred) {
                var target = _.find(nodes,function(node) { return node.id == pred;});
                // may be undefined if pred is out of project scope, need to figure out how to deal with that
                if (!_.isUndefined(target)) {
                    links.push({ source : node, target : target  });
                } else {
                    console.log("unable to find pred:",pred);
                }
            });
        });
        callback(null,nodes,links);

    },

    _setFilterNodes : function(nodes,links,callback) {

        _.each(links,function(link) {
            // is this link source the target of another link ? 
            var targets = _.filter(links,function(targetLink) {
                return link.source.id === targetLink.target.id;
            });
            // if not then we add it to the filter list.
            if (targets.length===0) {
                app.filterItems.push( { id: link.source.id, name: link.source.snapshot.get("FormattedID") + ": "+link.source.snapshot.get("Name") });
            }
        });

        app.filterItems = _.sortBy(app.filterItems,"name");
        app.filterStore.reload();

        callback(null,nodes,links);

    },

    // recursive method to walk the list of links
    _createLinkListForNode : function( node, list, nodes, links ) {

        list.push(node);
        // console.log(" walk to node:",node.id);
        var nodeLinks = _.filter(links,function(link) { return link.source.id === node.id; });
        // console.log("\tlinks:", _.map(nodeLinks,function(n){return n.target.id;}));
        _.each(nodeLinks, function(ln) {
            app._createLinkListForNode( ln.target, list, nodes, links);
        });

    },

    _createNodeList : function( nodes, links, callback ) {
        _.each(nodes, function(node) {
            var list = [];
            app._createLinkListForNode( node, list, nodes, links );
            node.list = list;
        });
        callback(null,nodes, links);
    },

    // the status for the node is based on its downstream dependencies in the list
    _createNodeStatus : function( nodes, links, callback ) {

        _.each(nodes, function(node) {
            _.each( node.list, function(listNode,i) {
                node.status = [];
                if (i > 0) {
                    var status = app._createStatusForNodes( node, listNode );
                    if ( status !== "status-good" )
                        node.status.push({ status : status, target : listNode });
                }
            });
        });
        callback( null, nodes, links );
    },

    _getIteration : function(iid) {

        var iteration = _.find( app.iterations,
            function(it){
                // console.log("iid",iid,it.get("ObjectID"));
                return (iid === it.get("ObjectID"));
            });

        return iteration;

    },

    _iterationEndDate : function(iid) {
        var iteration = app._getIteration(iid);
        return iteration ? iteration.raw.EndDate : null;
    },

    _createStatusForNodes : function( src, tgt ) {

        // is scheduled ? 
        var srcIteration = src.snapshot.get("Iteration");
        var tgtIteration = tgt.snapshot.get("Iteration");
        if ( _.isUndefined(tgtIteration) || _.isNull(tgtIteration) || tgtIteration === "" )
            // return "yellow";
            return "status-not-scheduled";
        // late ?
        if (!( _.isUndefined(srcIteration) || _.isNull(srcIteration)) &&
            !( _.isUndefined(tgtIteration) || _.isNull(tgtIteration))) {
            if ( app._iterationEndDate(tgtIteration) > app._iterationEndDate(srcIteration) )
                return "status-bad";
        }

        return "status-good";

    }
   
});
