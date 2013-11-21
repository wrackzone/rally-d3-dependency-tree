var app = null;

Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    maxHeight : 5,
    
    items : [ { xtype : "container", itemId : "10" }
    
    ],
    
    launch: function() {
        app = this;

        async.waterfall([ this.getDependencySnapshots,
                          this.findMissingSnapshots,
                          this.getProjectInformation,
                          this.getIterationInformation,
                          this._createGraph,
                          this._createNodeList,
                          this._createNodeStatus,
                          this._forceDirectedGraph
                          ], function(err,results){
           console.log("results",results); 
        });

    },

    getProjectInformation : function( snapshots, callback) {

        var projects = _.uniq(_.map( snapshots, function(s) { return s.get("Project"); }));

        async.map( projects, app.readProject, function(err,results) {
            app.projects = _.map(results,function(r) { return r[0]});
            console.log("projects", app.projects);
            callback(null,snapshots);
        });
    },

    getIterationInformation : function( snapshots, callback) {

        var iterations = _.uniq(_.map( snapshots, function(s) { return s.get("Iteration"); }));

        console.log("iterations",iterations);

        var readIteration = function( iid, callback) {

            var config = { model : "Iteration", 
                       fetch : ['Name','ObjectID','StartDate','EndDate'], 
                       filters : [{property : "ObjectID", operator : "=", value : iid}]};
            app.wsapiQuery(config,callback);
        };

        async.map( iterations, readIteration, function(err,results) {
            app.iterations = _.map(results,function(r) { return r[0]});

            app.iterations = _.reject(app.iterations,function(i) {return (i=="")||_.isUndefined(i)});
            console.log("iterations", app.iterations);
            callback(null,snapshots);
        });
    },

    readProject : function( pid, callback) {

        var config = { model : "Project", 
                       fetch : ['Name','ObjectID'], 
                       filters : [{property : "ObjectID", operator : "=", value : pid}]};
        app.wsapiQuery(config,callback);

    },

    wsapiQuery : function( config , callback ) {
        Ext.create('Rally.data.WsapiDataStore', {
            autoLoad : true,
            limit : "Infinity",
            model : config.model,
            fetch : config.fetch,
            filters : config.filters,
            listeners : {
                scope : this,
                load : function(store, data) {
                    console.log("wsapi:",data.length,data);
                    callback(null,data);
                }
            }
        });
    },
    
    findMissingSnapshots : function( snapshots, callback ) {
        var all = _.pluck(snapshots, function(s) { return s.get("ObjectID");});
        
        _.each(snapshots,function(s){
            var pr = s.get("Predecessors");
            var su = s.get("Successors");
            if ( _.isArray(pr)) {
                // console.log(_.difference( pr, all));
            }
            if ( _.isArray(su)) {
                // console.log(_.difference( pr, all));
            }
        });
        callback(null,snapshots);
    },
    
    getDependencySnapshots : function( callback ) {
        var that = this;
        var fetch = ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name','Project','Iteration'];
        var hydrate =  ['_TypeHierarchy','ScheduleState'];

        var find = {
            '_TypeHierarchy' : { "$in" : ["HierarchicalRequirement"]} ,
            '_ProjectHierarchy' : { "$in": app.getContext().getProject().ObjectID } , 
            '__At' : 'current',
            '$or' : [   
                {"Predecessors" : { "$exists" : true }},
                {"Successors" : { "$exists" : true }},
            ]
        };
        
        var storeConfig = {
            find : find,
            autoLoad : true,
            pageSize:1000,
            limit: 'Infinity',
            fetch: fetch,
            hydrate: hydrate,
            listeners : {
                scope : this,
                load: function(store, snapshots, success) {
                    callback(null,snapshots);
                }
            }
        };
        var snapshotStore = Ext.create('Rally.data.lookback.SnapshotStore', storeConfig);
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
        })

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
                    if ( status !== "Green" )
                        node.status.push({ status : status, target : listNode });
                }
            });
        });
        callback( null, nodes, links );
    },

    _iterationEndDate : function(iid) {

        // console.log(iid);

        var iteration = _.find( app.iterations,
            function(it){
                console.log("iid",iid,it.get("ObjectID"));
                return (iid === it.get("ObjectID"));
            });
        return iteration ? iteration.get("EndDate") : null;

    },

    _createStatusForNodes : function( src, tgt ) {

        // is scheduled ? 
        var srcIteration = src.snapshot.get("Iteration");
        var tgtIteration = tgt.snapshot.get("Iteration");
        if ( _.isUndefined(tgtIteration) || _.isNull(tgtIteration) )
            return "Yellow";
        // late ?
        if (!( _.isUndefined(srcIteration) || _.isNull(srcIteration)) &&
            !( _.isUndefined(tgtIteration) || _.isNull(tgtIteration))) {
            if ( app._iterationEndDate(tgtIteration) > app._iterationEndDate(srcIteration) )
                return "Red";
        }

    },

    getProjectColor : function( color, pid ) {
        var i = _.findIndex( app.projects, function(p) { return pid === p.get("ObjectID");} );
        return color(i);
    },

    addColorLegend : function(color) {

        var enter  = d3.select("body").select("svg")
            .selectAll('g')
            .data(app.projects, function(d,i) { return d.get("ObjectID"); })
            .enter();

        var divs = enter.append("g");

        divs.append('svg:circle')
                .attr('r', 5)
                .attr('cx',20)
                .attr('cy',function(d,i) { return (i+1)*20;})
                .style("fill", function(d,i) { return color(i); })
        divs.append('svg:text')
                .attr('x',20+10)
                .attr('y',function(d,i) { return ((i+1)*20)+3;})
                .text(function(d,i) { return d.get("Name")});
    },
    
    _forceDirectedGraph : function(nodes,links,callback) {
        
        var width = 1200,
            height = 500;
        
        var color = d3.scale.category20();

        var svg = d3.select("body").append("svg")
            .attr("width", width)
            .attr("height", height)
            .on('mousemove', app.myMouseMoveFunction);
            
        var div = d3.select("body")
            .append("div")
            .html("Some text")
            .classed("infobox",true);

        app.addColorLegend(color);

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
            .charge(-120)
            .linkDistance(50)
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
            .attr('marker-end', 'url(#end-arrow)');

        var circle = svg.append('svg:g').selectAll('g')
            .data(nodes, function(d) { return d.id; })
            .enter()
            .append('svg:g')
            .append('svg:circle')
                .attr('class', 'node')
                .attr('r', 5)
                // .style("fill", function(d) { return d.snapshot.get("ScheduleState") == "Accepted" ? "Green" : "Black"; })            
                .style("fill", function(d) { return app.getProjectColor( color, d.snapshot.get("Project")); })
                .call(force.drag)
                .on("mouseover", app.myMouseOverFunction)
                .on("mouseout", app.myMouseOutFunction);

        var circle1 = svg.append('svg:g').selectAll('g')
            .data(nodes, function(d) { return d.id; })
            .enter()
            .append('svg:g')
            .append('svg:circle')
                .attr('class', 'node1')
                .attr('r', 2)
                .style("fill", "green")  
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
            });

        });
    },
    
    // this will be ran whenever we mouse over a circle
	myMouseOverFunction : function(d) {
	    console.log("mouseover");
        var circle = d3.select(this);
        circle.attr("fill", "red" );
        // show infobox div on mouseover.
        // block means sorta "render on the page" whereas none would mean "don't render at all"
        var infobox = d3.select(".infobox");
        // var coord = d3.svg.mouse(this)
        var coord = d3.mouse(this)
        // now we just position the infobox roughly where our mouse is
        infobox.style("left", coord[0] + 15  + "px" );
        infobox.style("top", coord[1] + "px");

        infobox.style("display", "block");	
        infobox.html( d.snapshot.get("_UnformattedID")+":"+d.snapshot.get("Name"));
        // add test to p tag in infobox
        d3.select("p").text("This circle has a radius of " + circle.attr("r") + " pixels.");
    },
    
    myMouseOutFunction : function() {
        var circle = d3.select(this);
        circle.attr("fill", "steelblue" );
        // display none removes element totally, whereas visibilty in last example just hid it
        d3.select(".infobox").style("display", "none");
    },
 
	myMouseMoveFunction : function() {
	}
    
});
