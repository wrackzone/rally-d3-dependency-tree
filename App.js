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
                          this._createGraph,
                          this._forceDirectedGraph
                          ], function(err,results){
           console.log("results",results); 
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
        var fetch = ['ObjectID','_UnformattedID', '_TypeHierarchy', 'Predecessors','Successors','Blocked','ScheduleState','Name'];
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
    

    
    _fill : function (snapshots, snapshot) {
            var preds = snapshot.get("Predecessors");
            var that = this;
            if (_.isArray(preds)) {
                var children = _.map(preds, function(pred) { 
                    return _.find( snapshots, function(snap) { 
                        return pred == snap.get("ObjectID");
                    }); 
                });
                _.each(children, function(child) { that._fill(snapshots,child); });
                snapshot.children = children;
            }
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

        // this._forceDirectedGraph(nodes,links);
        // this._findMissingSnapshots(nodes);
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
            .attr('marker-end', 'url(#end-arrow)');

        // .style('marker-start', function(d) { return d.left ? 'url(#start-arrow)' : ''; })
        var circle = svg.append('svg:g').selectAll('g')
            .data(nodes, function(d) { return d.id; })
            .enter()
            .append('svg:g')
            .append('svg:circle')
                .attr('class', 'node')
                .attr('r', 5)
                .style("fill", function(d) { return d.snapshot.get("ScheduleState") == "Accepted" ? "Green" : "Black"; })            
                .call(force.drag)
                .on("mouseover", app.myMouseOverFunction)
                .on("mouseout", app.myMouseOutFunction);  	

        force.on("tick", function() {
            path.attr('d', function(d) {
            var deltaX = d.target.x - d.source.x,
                deltaY = d.target.y - d.source.y,
                dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY),
                normX = deltaX / dist,
                normY = deltaY / dist,
                sourcePadding = 0, // d.left ? 17 : 12,
                targetPadding = 8, // d.right ? 17 : 12,
                sourceX = d.source.x + (sourcePadding * normX),
                sourceY = d.source.y + (sourcePadding * normY),
                targetX = d.target.x - (targetPadding * normX),
                targetY = d.target.y - (targetPadding * normY);
            return 'M' + sourceX + ',' + sourceY + 'L' + targetX + ',' + targetY;
            });

            circle.attr('transform', function(d) {
                return 'translate(' + d.x + ',' + d.y + ')';
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
        // save selection of infobox so that we can later change it's position
        var infobox = d3.select(".infobox");
        // this returns x,y coordinates of the mouse in relation to our svg canvas
        //var coord = d3.svg.mouse(this)
        var coord = d3.mouse(this)
        // now we just position the infobox roughly where our mouse is
        infobox.style("left", coord[0] + 15  + "px" );
        infobox.style("top", coord[1] + "px");
	}
    
});
