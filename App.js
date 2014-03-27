var app = null;

Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    maxHeight : 5,
    
    items : [ { xtype : "container", itemId : "10" }
    
    ],

    launch: function() {
        app = this;
        app.hideAccepted = app.getSetting('hideAccepted') === true;
        console.log("hideAccepted",app.hideAccepted);
        app.container_id = this.down("container").id;
        

        app.myMask = new Ext.LoadMask(Ext.getBody(), {msg:"Please wait..."});
        app.myMask.show();

        async.waterfall([ //this.getClosedProjects,
                          this.getDependencySnapshots,
                          this.findMissingSnapshots,
                          this.getProjectInformation,
                          this.cleanUpSnapshots,
                          this.getIterationInformation,
                          this._createGraph,
                          this._createNodeList,
                          this._createNodeStatus,
                          this._createDagreGraph
                          // this._createGraph,
                          // this._createNodeList,
                          // this._createNodeStatus,
                          // this._forceDirectedGraph
                          ], function(err,results){
                            app.myMask.hide();
           console.log("results",results); 
        });

    },

    config: {
        defaultSettings: {
            hideAccepted : true
        }
    },

    getSettingsFields: function() {
        return [
            {
                name: 'hideAccepted',
                xtype: 'rallycheckboxfield',
                label : "True to hide accepted stories"
            }
        ];
    },

    getClosedProjects : function ( callback ) {

        var config = { 
            model : "Project", 
            fetch : ['Name','ObjectID','State'], 
            filters : [{property : "State", operator : "=", value : "Closed"}]
        };

        async.map([config],app.wsapiQuery,function(err,results){
            app.closedProjects = _.map(results[0],function(p) {return p.get("ObjectID");});
            console.log("closedProjects",app.closedProjects);
            callback(null,null);
        });

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
            '_ProjectHierarchy' : { "$in": app.getContext().getProject().ObjectID } , 
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

        // d3 rendering
        var svg = d3.select("body").append("div").attr("class","div-container").append("svg")
        // var svg = d3.select(app.container_id).append("svg")
            .attr("class","svg")
            .attr("width", width)
            .attr("height", height)
                .append("g")
                .attr("transform","translate(20,20)");
            // .on('mousemove', app.myMouseMoveFunction);

        var renderer = new dagreD3.Renderer();
        renderer.run(g, d3.select("svg g"));
        callback(null,nodes,links);

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

    },

    _nodeStatusStyle : function( node ) {

        var red = _.find(node.status,function(s) { return s.status == "red";});
        if (red)
            return 'red';
        var yellow = _.find(node.status,function(s) { return s.status == "yellow";});
        if (yellow)
            return 'yellow';

        return 'green';

    },

    _linkStatusStyle : function ( link ) {

        var status = app._createStatusForNodes( link.source, link.target );

        return status;
    },

    getProjectColor : function( pid ) {
        var i = _.findIndex( app.projects, function(p) { return !_.isUndefined(p) ? pid === p.get("ObjectID") : false;} );
        return app.color(i);
    },

    addColorLegend : function(color,w,h) {

        var div = d3.select("body").select("svg")
            .append("svg:g")
            .attr("class","color-legend")
            .attr("transform","translate(" + ((w/5)*4) +",20)");

        // console.log("select",d3.select("body").select("svg").select(".color-legend"));

        var enter  = d3.select("body").select("svg").select(".color-legend")
            .selectAll('g')
            .data(app.projects, function(d,i) { return !_.isUndefined(d) ? d.get("ObjectID") : ""; })
            .enter();

        var divs = enter.append("g");

        divs.append('svg:circle')
                .attr('r', 5)
                .attr('cx',20)
                .attr('cy',function(d,i) { return (i+1)*20;})
                .style("fill", function(d,i) { return color(i); });
        divs.append('svg:text')
                .attr('x',20+10)
                .attr('y',function(d,i) { return ((i+1)*20)+3;})
                .text(function(d,i) { return !_.isUndefined(d) ? d.get("Name") : "";});


    },
    
    _forceDirectedGraph : function(nodes,links,callback) {
        
        var width = 1200,
            height = 800;
        
        app.color = d3.scale.category20b();

        var svg = d3.select("body").append("svg")
            .attr("class","svg")
            .attr("width", width)
            .attr("height", height)
            .on('mousemove', app.myMouseMoveFunction);
            
        var div = d3.select("body")
            .append("div")
            .html("Some text")
            .classed("infobox",true);

        app.addColorLegend(app.color,width,height);

        // define arrow markers for graph links
        svg.append('svg:defs').append('svg:marker')
            .attr('id', 'end-arrow')
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 6)
            .attr('markerWidth', 5)
            .attr('markerHeight', 5)
            .attr('orient', 'auto')
          .append('svg:path')
            .attr('d', 'M0,-5L10,0L0,5')
            .attr('fill', '#000');

        svg.append('svg:defs').append('svg:marker')
            .attr('id', 'start-arrow')
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 4)
            .attr('markerWidth', 3)
            .attr('markerHeight', 3)
            .attr('orient', 'auto')
          .append('svg:path')
            .attr('d', 'M10,-5L0,0L10,5')
            .attr('fill', '#000');

        var force = d3.layout.force()
            .charge(-90)
            .linkDistance(30)
            .size([width, height])
            .nodes(nodes)
            .links(links)
            .start();

        // handles to link and node element groups
        var path = svg.append('svg:g').selectAll('path')
            .data(links)
            .enter()
            .append('svg:path')
            .attr('class', 'link')
            .attr('stroke-dasharray', function(d) {
                var status = app._linkStatusStyle(d);
                return status == "red" ? "2,2" : ""; 
            })
            .attr('marker-end', 'url(#end-arrow)');

        var statusNodes = _.filter(nodes, function(n) { 
            return app._nodeStatusStyle(n) !== "green";
        });

        var circle = svg.append('svg:g').selectAll('g')
            .data(nodes, function(d) { return d.id; })
            .enter()
            .append('svg:g')
            .append('svg:circle')
                .attr('class', 'node')
                .attr('r', 5)
                // .style("fill", function(d) { return d.snapshot.get("ScheduleState") == "Accepted" ? "Green" : "Black"; })            
                .style("fill", function(d) { return app.getProjectColor( d.snapshot.get("Project")); })
                .call(force.drag)
                .on("mouseover", app.myMouseOverFunction)
                .on("mouseout", app.myMouseOutFunction)
                .on("click", app.myMouseClick);

        var circle1 = svg.append('svg:g').selectAll('g')
            .data(statusNodes, function(d) { return d.id; })
            .enter()
            .append('svg:g')
            .append('svg:circle')
                .attr('class', 'node1')
                .attr('r', 2)
                .style("fill", function(d) { return app._nodeStatusStyle(d);})  
                .call(force.drag);

        force.on("tick", function() {
            path.attr('d', function(d) {
            var deltaX = d.target.x - d.source.x,
                deltaY = d.target.y - d.source.y,
                dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY),
                normX = deltaX / dist,
                normY = deltaY / dist,
                sourcePadding = 10, // d.left ? 17 : 12,
                targetPadding = 10, // d.right ? 17 : 12,
                sourceX = d.source.x + (sourcePadding * normX),
                sourceY = d.source.y + (sourcePadding * normY),
                targetX = d.target.x - (targetPadding * normX),
                targetY = d.target.y - (targetPadding * normY);
            return 'M' + sourceX + ',' + sourceY + 'L' + targetX + ',' + targetY;
            });

            circle.attr('transform', function(d) {
                return 'translate(' + d.x + ',' + d.y + ')';
            });

            circle1.attr('transform', function(d) {
                return 'translate(' + (d.x-6) + ',' + (d.y-6) + ')';
                //return 'translate(' + d.x + ',' + d.y + ')';
            });

        });

        callback(null,nodes,links);
    },

    _createStoryDetails : function( node ) {

        var s = node.snapshot;
        var box = d3.select(".infobox");

        box.html("");
        box.append("div").attr("class","title").html("S"+s.get("_UnformattedID")+":"+s.get("Name"));

        _.each( node.list.slice(1), function(d) {
            var ds = d.snapshot;
            var color = app.getProjectColor(ds.get("Project"));
            var iteration = app._getIteration(ds.get("Iteration"));
            var iterationName = iteration ? iteration.get("Name") : "";
            var iterationEnd  = iteration ? iteration.get("EndDate") : "";
            var m = iteration ? moment(iterationEnd).format("(MMM DD)") : "";

            //box.append("div").attr("class","item").attr("style","color:white;background-color:"+color+";").html("S"+ds.get("_UnformattedID")+":"+ds.get("Name"));
            
            var item = box
                .append("div")
                    .attr("class","item")
                    .attr("style","color:white;background-color:"+color+";")
                    .html("S"+ds.get("_UnformattedID")+":"+ds.get("Name"));
            item.append("div").attr("style","color:white;background-color:red;").html( ds.get("Blocked") ? "Blocked":"");

            var itStatus = app._createStatusForNodes(node,d);
            var textColor = itStatus === "yellow" ? "black" : "white";
            console.log("status check:",node.snapshot.get("_UnformattedID"),d,itStatus);
            var itMessage = iteration ? iteration.get("Name") + " " + m : "Unscheduled";
            item.append("div").html(itMessage).attr("style","color:"+textColor+";background-color:"+itStatus+";");
        });


    },

    myMouseClick : function(d) {
        console.log("click:",d);
        app._createStoryDetails(d);
    },
    
    // this will be ran whenever we mouse over a circle
	myMouseOverFunction : function(d) {
        var circle = d3.select(this);
        circle.attr("fill", "red" );
        // show infobox div on mouseover.
        // block means sorta "render on the page" whereas none would mean "don't render at all"
        var infobox = d3.select(".infobox");
        // var coord = d3.svg.mouse(this)
        var coord = d3.mouse(this);
        // now we just position the infobox roughly where our mouse is
        infobox.style("left", coord[0] + 15  + "px" );
        infobox.style("top", coord[1] + "px");

        infobox.style("display", "block");	
        infobox.html( d.snapshot.get("_UnformattedID")+":"+d.snapshot.get("Name"));
        // add test to p tag in infobox
        d3.select("p").text("This circle has a radius of " + circle.attr("r") + " pixels.");
    },
    
    myMouseOutFunction : function() {
        // var circle = d3.select(this);
        // circle.attr("fill", "steelblue" );
        // // display none removes element totally, whereas visibilty in last example just hid it
        // d3.select(".infobox").style("display", "none");
    },
 
	myMouseMoveFunction : function() {
	}
    
});
