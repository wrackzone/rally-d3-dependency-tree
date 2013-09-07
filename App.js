Ext.define('CustomApp', {
    extend: 'Rally.app.App',
    componentCls: 'app',
    maxHeight : 50,
    
    items : [ { xtype : "container", itemId : "10" }
    
    ],
    
    listeners : { render : function() {
        console.log("rendered");
    }},
    
    launch: function() {
        //Write app code here
        this._createStore();
        
    },
    _createStore : function() {
        var that = this;
        
        // {find:{ _ProjectHierarchy : { "$in": 380227538 } , 
        //     _ValidTo : "9999-01-01T00:00:00Z", 
        //     _TypeHierarchy : { "$in" : ["HierarchicalRequirement"]}, 
        //     "$or" : [ {"Predecessors" : {"$exists" : true }} , {"Successors" : { "$exists" : true }}  ] },
        // fields : ["ObjectID","_TypeHierarchy","Predecessors","Successors"],
        // hydrate: ["_TypeHierarchy"]
        // }

        // filter for just projects in scope and for current snapshots        
        var filter = Ext.create('Rally.data.lookback.QueryFilter', {
                property: '_ProjectHierarchy',
                operator : 'in',
                value : [that.getContext().getProject().ObjectID] // 5970178727
            }
        );
        filter = filter.and( Ext.create('Rally.data.lookback.QueryFilter', {
                property: "_ValidTo",
                operator : "=",
                value : "9999-01-01T00:00:00Z"
            }
            )
        );

        // filter only if predecessors or successors are set
        var depFilter = Ext.create('Rally.data.lookback.QueryFilter', {
            property: 'Predecessors',
            operator: 'exists',
            value : true
        });
        
        depFilter = depFilter.or( Ext.create('Rally.data.lookback.QueryFilter', {
                property: 'Successors',
                operator: 'exists',
                value : true
            })
        );
        
        filter = filter.and(depFilter);

        Ext.create('Rally.data.lookback.SnapshotStore', {
            autoLoad: true,
            limit : "Infinity",
            listeners: {
                load: function(dataStore, records) {
                    console.log("records:",records.length);
                    this._createGraph(records);
                },
                scope: that
            },
            fetch: ['ObjectID','_UnformattedID', 'Tags', '_User', '_TypeHierarchy', '_PreviousValues','Predecessors','Successors'],
            hydrate: ['_TypeHierarchy'],
            filters : [filter]
        });
    },
    
    _fill : function (snapshots, snapshot) {
            var preds = snapshot.get("Predecessors");
            var that = this;
            if (_.isArray(preds)) {
                var children = _.map(preds, function(pred) { return _.find( snapshots, function(snap) { 
                    return pred == snap.get("ObjectID");
                } ) })
                _.each(children, function(child) { that._fill(snapshots,child); });
                snapshot.children = children;
            }
    },
    
    _createGraph : function( snapshots ) {
        var that = this;
        var p = _.filter(snapshots,function(rec) { return _.isArray(rec.get("Predecessors"));});
        var s = _.filter(snapshots,function(rec) { return _.isArray(rec.get("Successors"));});
        console.log("p",p);
        console.log("s",s);

        // create the set of node elements
        var nodes = _.map( snapshots, function(snap) {
            if (_.isArray(snap.get("Predecessors"))||_.isArray(snap.get("Successors"))) {
                return { id : snap.get("ObjectID"), snapshot : snap };
            } else {
                return null;
            }
        });
        nodes = _.compact(nodes);

        // create the links
        var links = [];
        _.each(nodes, function(node) {
            _.each(node.snapshot.get("Predecessors"), function(pred) {
                var target = _.find(nodes,function(node) { return node.id == pred;});
                // may be undefined if pred is out of project scope, need to figure out how to deal with that
                if (!_.isUndefined(target)) {
                    links.push( 
                        { source : node, target : target  }
                    );
                }
            });
        });

        this._forceDirectedGraph(nodes,links);
    },
    
    _forceDirectedGraph : function(nodes,links) {

        console.log(nodes,links);
        var width = 1200,
            height = 600;
        
        var color = d3.scale.category20();
        
        var force = d3.layout.force()
            .charge(-40)
            .linkDistance(10)
            .size([width, height]);
            
        var svg = d3.select("body").insert("svg")
            .attr("width", width)
            .attr("height", height);
            
        force
            .nodes(nodes)
            .links(links)
            .start();
            
        var link = svg.selectAll(".link")
            .data(links)
            .enter().append("line")
            .attr("class", "link")
            .style("stroke-width", function(d) { return Math.sqrt(d.value); });
            
        var node = svg.selectAll(".node")
            .data(nodes)
            .enter().append("circle")
            .attr("class", "node")
            .attr("r", 5)
            //   .style("fill", function(d) { return color(d.group); })
            .call(force.drag);
            
        node.append("title")
            .text(function(d) { return d.name; });
            
        force.on("tick", function() {
            link.attr("x1", function(d) { return d.source.x; })
            .attr("y1", function(d) { return d.source.y; })
            .attr("x2", function(d) { return d.target.x; })
            .attr("y2", function(d) { return d.target.y; });
            
            node.attr("cx", function(d) { return d.x; })
                .attr("cy", function(d) { return d.y; });
            });
    }

});
