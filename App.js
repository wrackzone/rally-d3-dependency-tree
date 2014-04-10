var app = null;

Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    maxHeight : 5,
    
    items : [ 
        // {
        //     itemId : "exportLink"
        // },
        // { 
        //     xtype : "container", 
        //     itemId : "10" 
        // }  
    ],

    launch: function() {
        app = this;
        app.hideAccepted = app.getSetting('hideAccepted') === true;
        console.log("hideAccepted",app.hideAccepted);
        // app.container_id = this.down("container").id;
        

        app.myMask = new Ext.LoadMask(Ext.getBody(), {msg:"Please wait..."});
        app.myMask.show();

        async.waterfall([ 
                          this.getDependencySnapshots,
                          this.findMissingSnapshots,
                          this.getProjectInformation,
                          this.cleanUpSnapshots,
                          this.getIterationInformation,
                          this._createGraph,
                          this._createNodeList,
                          this._createNodeStatus,
                          this._createDagreGraph,
                          this._createGraphViz
                          ], 
            function(err,results){
                app.myMask.hide();
                console.log("results",results); 
            }
        );
    },

    config: {
        defaultSettings: {
            hideAccepted   : true,
            showExportLink : true
        }
    },

    getSettingsFields: function() {
        return [
            {
                name: 'hideAccepted',
                xtype: 'rallycheckboxfield',
                label : "True to hide accepted stories"
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
        // console.log("project oids:",projects);
        // var ss = _.filter(snapshots, function(s) { return s.get("Project")==projects[0];});
        // console.log("strange snapshots",ss);
        async.map( projects, app.readProject, function(err,results) {
            app.projects = _.compact(_.map(results,function(r) { return r[0];}));
            console.log("projects", app.projects);
            console.log("closed projects:", 
                _.filter(app.projects,function(p){
                    return p.get("State")==="Closed";
                })
            );
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
        console.log("filtered snapshots:",snaps.length);

        callback(null,snaps);

    },

    getIterationInformation : function( snapshots, callback) {

        var iterations = _.uniq(_.map( snapshots, function(s) { return s.get("Iteration"); }));

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
        config.fetch = ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name','Project','Iteration','FormattedID'];
        config.hydrate =  ['_TypeHierarchy','ScheduleState'];
        config.find = {
            'ObjectID' : { "$in" : missing },
            '__At' : 'current',
            'Project' : { "$exists" : true},
            'Project' : { "$ne" : null}
        };

        async.map([config],app._snapshotQuery,function(err,results) {
            console.log("missing snapshots:",results[0]);
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
    
    getDependencySnapshots : function( callback ) {

        var that = this;
        var config = {};

        config.fetch = ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name','Project','Iteration','FormattedID'];
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
                    console.log("snapshots:",snapshots.length);
                    callback(null,snapshots);
                }
            }
        };
        var snapshotStore = Ext.create('Rally.data.lookback.SnapshotStore', storeConfig);

    },

    _renderNodeLabel : function( node ) {

        // get the project name
        var project = _.find(app.projects, function(p) { 
            return node.snapshot.get("Project") === p.get("ObjectID");
        });

        if (_.isUndefined(project)||_.isNull(project)) {
            console.log("problem with project for:",node);
        }

        var iterationEndDate = app._iterationEndDate(node.snapshot.get("Iteration"));
        var date_span="";
        var date_style = null;
        if (iterationEndDate) {
            if (node.status.length > 0)
                date_style = node.status[0].status;
        }

        date_span= "<span class='"+date_style+"'>" + (iterationEndDate ? moment(iterationEndDate).format("MM/DD/YYYY") : "") +"</span>";

        var idstyle = "";
        if (node.snapshot.get("ScheduleState")==="Accepted") {
            //idstyle = "color:black;background-color:00FF66"
            idstyle="accepted-story";
        }

        var state_class = node.snapshot.get("Blocked") === true ? "status-blocked" : "";
        var state_span = "<span class='"+state_class+"'>" + " [" + node.snapshot.get("ScheduleState").substring(0,1) + "] ";

        return "<table class='graph-node'>" + 
                "<tr><td>" + "<span class='story-name'><span class="+idstyle+">" + 
                //node.snapshot.get("FormattedID") + "</span>" + ":" + node.snapshot.get("Name").substring(0,35) +
                node.snapshot.get("FormattedID") + "</span>" + ":" + node.snapshot.get("Name") +
                state_span + "</span>" +
                "</td></tr>" + 
                "<tr><td>" + 
                "Project:"+ ( _.isUndefined(project) || _.isNull(project) ? "Closed" : project.get("Name") ) +
                "</td></tr>" + 
                "<tr><td>" + 
                date_span +
                "</td></tr>" + 
               "</tr></table>";

    },
    
    _createDagreGraph : function( nodes, links,callback ) {

        var g = new dagre.Digraph();

        _.each(nodes, function(node){
            //g.addNode(node.id, { label : node.snapshot.get("Name")});
            g.addNode(node.id, { label : app._renderNodeLabel(node)});
        });

        _.each(links, function(link){
            g.addEdge(null, link.source.id, link.target.id, {label:""});
        });

        var width = 64000,
            height = 32000;

        var container = Ext.create("Ext.container.Container",{
            listeners:{
                afterrender:function(i) {
                    console.log("rendered",i,this);

                    console.log("d3 container",d3.select("#"+container.id));

                    var svg = d3.select("body").append("div").attr("class","div-container").append("svg")
                    // var svg = d3.select(app.container_id).append("svg")
                        .attr("class","svg")
                        // .attr("width", width)
                        // .attr("height", height)
                            .append("g")
                            .attr("transform","translate(10,10)");

                    console.log("d3 svg",d3.select("svg g"));

                    var renderer = new dagreD3.Renderer();
                    renderer.run(g, d3.select("svg g"));
                    callback(null,nodes,links);
                }
            }
        });
        app.add(container);
    },

    _formatGraphVizNode : function (node) {

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
        g = g + node.snapshot.get("FormattedID") + ":" + node.snapshot.get("Name") + " [" + node.snapshot.get("ScheduleState").substring(0,1) + "] ";
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

        console.log("========================");
        console.log(gv);
        console.log("========================");

        app.gv = gv;

        if (app.getSetting('showExportLink') === true) {
            // var link = app.down("#exportLink");
            // var link = Ext.create("Ext.container.Container",{
            // });
            // link.update(app._createLink(app.gv));
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
            // console.log("node:",node.id);
            var list = [];
            app._createLinkListForNode( node, list, nodes, links );
            // console.log("List:",_.map(list,function(l){return l.id;}));
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
