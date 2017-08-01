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

    launch: function() {
        app = this;
        app.filterItems = [];
        app.filterStore = Ext.create('Ext.data.Store',{
            // remoteSort : true,
            sorters: [{
                property: 'name',
                direction: 'ASC'
            }],
            fields:['id',{name:'name',type:'string'}],
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
                if (err !== undefined && err !== null) {
                    app.myMask.hide();
                    console.log("err",err);
                    Rally.ui.notify.Notifier.show({message: err});
                    app.add(err);
                }
                
                app.myMask.hide();
                app.nodes = nodes;
                app.links = links;
            }
        );
    },

    config: {
        defaultSettings: {
            showFilter     : true,
            hideAccepted   : false,
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

        // console.log("unfiltered snapshots:",snapshots.length);
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

    createIterationFilter : function(iterationIds) {

        var filter = null;

        _.each( iterationIds, function( iterationId, i ) {
            var f = Ext.create('Rally.data.wsapi.Filter', {
                    property : 'ObjectID', operator : '=', value : iterationId }
            );
            filter = (i===0) ? f : filter.or(f);
        });
        // console.log("Iteration Filter:",filter.toString());
        return filter;
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
        var iterationChunks = app.chunkArray(iterations);
        console.log("Iteration Chunks:",iterations.length,iterationChunks.length);

        var readIteration = function( iids, callback) {
            var config = { 
                model : "Iteration", 
                fetch : ['Name','ObjectID','StartDate','EndDate'], 
                // filters : app.createIterationFilter(iids),
                context : { project : null}
            };
            app.wsapiQuery(config,callback);
        };

        async.map( iterationChunks, readIteration, function(err,results) {
            console.log("iteration results",results);
            app.iterations = _.flatten(results);
            // app.iterations = _.flatten( _.map(results,function(r) { return r[0]; }) );
            // app.iterations = _.reject(app.iterations,function(i) { return (i==="") || _.isUndefined(i);});
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

    chunkArray : function( arr ) {
        var oidsArrays = [];
        var i,j,chunk = 50;
        for (i=0, j=arr.length; i<j; i+=chunk) {          
            oidsArrays.push(arr.slice(i,i+chunk));
        }
        // console.log("oidsArrays",oidsArrays);
        return oidsArrays;

    },
    
    findMissingSnapshots : function( snapshots, callback ) {

        var missing = app.getMissingSnapshots(snapshots);
        console.log("missing:",missing,missing.length);

        var oidsArrays = app.chunkArray(missing);

        var configs = _.map( oidsArrays, function(oArray) {
            return {
                fetch : ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name','Project','Iteration','FormattedID','Children'],
                hydrate :  ['_TypeHierarchy','ScheduleState'],
                find : {
                    'ObjectID' : { "$in" : oArray },
                    '__At' : 'current',
                    'Project' : { "$exists" : true},
                    'Project' : { "$ne" : null}
                }
            }
        });

        async.map(configs,app._snapshotQuery,function(err,results) {

            _.each(results,function(result) {
                _.each(result,function(s) {
                    snapshots.push(s);
                });
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

        // console.log("epics",epicSnapshots);

        async.map( epicSnapshots, app.leafNodeSnapshots,function(err,results) {

            // console.log("epic results:",results);
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
            // '_ProjectHierarchy' : { "$in": [app.getContext().getProject().ObjectID]}, 
            'Children' : null,
            '__At' : 'current',
        };

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
            // console.log("snapshots:",results[0]);
            if (results[0].length>0)
                callback(null,results[0]);
            else
                callback("No Stories with dependencies in selected project scope",null);
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
        // var iterationEndDate = app._iterationEndDate(node.snapshot.get("Iteration"));
        var iterationEndDate = app._iterationEndDate(app._getSnapshotIteration(node.snapshot));
        iterationEndDate = iterationEndDate ? moment(iterationEndDate).format("MM/DD/YYYY") : "";
        if (iterationEndDate) {
            if (node.status.length > 0)
                date_class = node.status[0].status;
        }
        // console.log("date:",iterationEndDate);

        var childCount = node.snapshot.get('Children').length > 0 ? " (" + node.snapshot.get('Children').length + ")" : "";

        var tpl = Ext.create('Ext.Template', 
        "<table class='graph-node'>" +
            "<tr><td><div style='width: 16em;'><a class='{id_style}' href='{id_ref}' target='_blank'>{id}</a> : {name}<span class='{state_class}'> [{state}] </span><span>{child_count}</span></div></td></tr>" +
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

        // var iterationEndDate = app._iterationEndDate(node.snapshot.get("Iteration"));
        var iterationEndDate = app._iterationEndDate(app._getSnapshotIteration(node.snapshot));

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

            var autoEl = Ext.create('Ext.Component',{
                itemId : 'autoel-export',
                autoEl : {
                    tag : 'a',
                    href : 'data:text/dot;charset=utf8,' + encodeURIComponent(app.gv),
                    download : 'export.dot',
                    html : 'Click to download dot file'
                }
            });

            console.log("adding export link");
            var link = app.down("#exportLink");
            var f;
            while(f = link.items.first()){
                link.remove(f, true);
            }
            link.add(autoEl);
        }

        callback(null,nodes,links);

    },

    _createLink : function(gvString) {
        var l = "<a href='data:text/dot;charset=utf8," + encodeURIComponent(gvString) + "' download='export.dot'>Click to download dot file</a>";
        // var l = "<a href='data:text/dot;charset=utf8," + gvString + "' download='export.dot'>Click to download dot file</a>";
        console.log(l);
        console.log(l.length);
        return l;
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
                    // var dupFound = _.find(links,function(link){
                    //     return link.source.id === node.id && link.target.id === target.id;
                    // });
                    // console.log("dup:",dupFound,node.id,target.id);

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

        app.filterItems = _.uniq(app.filterItems,"name");
        // app.filterItems = _.sortBy(app.filterItems,"name");
        // console.log("filter store",app.filterItems);
        app.filterStore.sort();
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
                if (!node.status) node.status = [];
                
                if (i > 0) {
                    var status = app._createStatusForNodes( node, listNode );
                    if ( status !== "status-good" )
                        node.status.push({ status : status, target : listNode });
                    console.log("node status:",node);
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
        return iteration ? 
                    Rally.util.DateTime.fromIsoString(iteration.raw.EndDate) 
                    : null;
    },

    // used to get the iteration on the snapshot. if an epic snapshot it will be last iteration
    // of the leafnodes.
    _getSnapshotIteration : function(snapshot) {
        var leafNodes = snapshot.get("LeafNodes");

        // if child snapshot then just return the iteration
        if (_.isUndefined(leafNodes)||_.isNull(leafNodes)||leafNodes.length===0) {
            return snapshot.get("Iteration");
        }
        // otherwise return the last of the leaf nodes based on iteration end date. 
        var max = _.max(leafNodes, function(leaf) {
            var i = leaf.get("Iteration");
            return app._iterationEndDate(i);
        });
        // console.log("max",max);
        return max.get("Iteration");
    },

    _createStatusForNodes : function( src, tgt ) {

        // is scheduled ? 
        // var srcIteration = src.snapshot.get("Iteration");
        var srcIteration = app._getSnapshotIteration(src.snapshot);
        // var tgtIteration = tgt.snapshot.get("Iteration");
        var tgtIteration = app._getSnapshotIteration(tgt.snapshot);
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

    },


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

        app._createDagreGraph(newNodes,newLinks,function(err,nodes,links) {

            console.log("filtering graph viz");
            app._createGraphViz(newNodes,newLinks,function(err,n,l) {

            });
            
        })
    }



   
});
