# Neuromni

This directory implements the interface for editing clusters of supervoxels, by
adding and removing edges of a graph. There are three major components:

1. Chunked graph management 
1. Operations queue management 
1. Mesh update management

## Chunked graph management 

When selecting a cluster, the client will begin to download the cluster's
associated region graph based on proximity to the viewport. The region graph is 
transmitted in chunks.

For petabyte-scale datasets, neurons could have clusters with billions of 
supervoxels, though we expect the average neuron to have millions of 
supervoxels. Supervoxels have an ID and a centroid. Supervoxels have edges 
between them with a weight indicating the likelihood that the supervoxels are in 
the same cluster. We estimate maybe 8 edges per supervoxel, which would mean
tens of millions to tens of billions of edges per neuron. 

Since we expect the graph for any individual neuron to be MBs to GBs, we've 
decided to handle subgraphs based on the viewport.

## Operations queue management

We support the following operations:

1. **Merge**

Join two clusters together. This is done by adding an edge between the two 
supervoxels selected while in merge mode.

1. **Split**

Divide one cluster into two. This is done by removing a set of edges between 
a set of source and sink supervoxels. The set of edges will be determined by 
a weighted mincut algorithm.

1. **Relabel**


# How neuroglancer works, for dummies.

* The top class is a Viewer. It contains:
** display, describing the window and controlling the GL
** navigationState, describing where the viewer currently is in space
** mouseState, describing what the mouse is doing
** layerManager, describing each set of data that's been loaded.
** layerSelectedValues, listing which segments have been selected for each 
layer.
** layerSpecification (usually topLevelLayerListSpecification), containing the 
chunkManager.

The layerManager contains each layer that has been loaded under its
managedLayer class. A common managed layer type is 
ManagedUserLayerWithSpecification, which contains information about the
datasource, type, and whether a chunkedGraph is associated.

The managedLayer contains references to the layer it represents. For 
segmentations, that's a segmentationUserLayer, which contains information about
the displayState (colors, shaders, alphas, etc). Each layer contains a
meshLayer, which is populated based on the path in the info file. Each layer 
also has a list of renderLayers, which includes a segmentationRenderLayer,
as well as the same meshLayer. The segmentationRenderLayer stores information 
about which chunks have been loaded under source(s).

For simplicity, Nico assigned the chunkedGraph to the meshLayer. He then 
easily piggy-backed on its the meshLayer's chunk services.

# How we implemented the graph
