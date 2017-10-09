/*
Passing variables / arrays between cython and cpp
Example from 
http://docs.cython.org/src/userguide/wrapping_CPlusPlus.html

Adapted to include passing of multidimensional arrays

*/

#include <zi/mesh/int_mesh.hpp>
#include <zi/mesh/face_mesh.hpp>
#include <zi/mesh/quadratic_simplifier.hpp>
#include <zi/vl/vec.hpp>
#include <zi/vl/vec_functions.hpp>
#include <vector>
#include <fstream>
#include <map>
#include <set>
#include <algorithm>


#include "cMesher.h"

//////////////////////////////////
cMesher::cMesher()
{
}

cMesher::~cMesher()
{
}


bool WriteObj(zi::mesh::simplifier<double> & s, const std::string & filename) {
  std::vector<zi::vl::vec3d> points;
  std::vector<zi::vl::vec3d> normals;
  std::vector<zi::vl::vec<unsigned,3> > faces;

  s.get_faces(points, normals, faces);

  std::ofstream out(filename.c_str(), std::ios::out);
  if (out) {
    for (auto v = points.begin(); v < points.end(); ++v) {
      out << "v " << (*v)[2] << " " << (*v)[1] << " " << (*v)[0] << "\n";
    }

    for (auto vn = normals.begin(); vn < normals.end(); ++vn) {
      out << "vn " << (*vn)[2] << " " << (*vn)[1] << " " << (*vn)[0] << "\n";
    }

    for (auto f = faces.begin(); f < faces.end(); ++f) {
      out << "f " << (*f)[0] + 1 << "//" << (*f)[0] + 1 << " " << (*f)[2] + 1
        << "//" << (*f)[2] + 1 << " " << (*f)[1] + 1 << "//" << (*f)[1] + 1
        << "\n";
    }
    return true;
  }
  return false;
}

// n needs to be allocated in advance
template< class T >
void calc_normals(zi::vl::vec<T,3>* n, const zi::vl::vec<T,3>* p, std::size_t psize,
                  const zi::vl::vec<uint32_t, 3>* f, std::size_t fsize) {
  memset(n, 0, psize * sizeof(zi::vl::vec<T,3>));
  zi::vl::vec<T,3> face_normal;
  for (int i = 0; i < fsize; ++i) {
    face_normal = zi::vl::normal<T,3>(p[f[i][0]], p[f[i][1]], p[f[i][2]]);
    n[f[i][0]] += face_normal;
    n[f[i][1]] += face_normal;
    n[f[i][2]] += face_normal;
  }

  for (int i = 0; i < psize; ++i) {
    zi::vl::normalize<T,3>(n[i]);
  }
}

template < class T >
unsigned make_manifold(zi::mesh::face_mesh<T> &mesh) {
  std::map<std::pair<uint32_t, uint32_t>, std::pair<uint32_t, uint32_t>> edge_face_map;
  std::set<uint32_t> bad_faces;

  for (int i = 0; i < mesh.faces().size(); ++i) {
    for (int j = 0; j < 3 ; ++j) {
      std::pair<uint32_t, uint32_t> unordered_edge = std::minmax(mesh.faces()[i][j], mesh.faces()[i][j==2 ? 0 : j+1]);
      std::map<std::pair<uint32_t, uint32_t>, std::pair<uint32_t, uint32_t>>::iterator it = edge_face_map.find(unordered_edge);
      if ( it == edge_face_map.end()) {
        auto p = std::make_pair(unordered_edge, std::make_pair(i, -1));
        edge_face_map.insert(p);
      }
      else {
        if (it->second.second == -1) {
          it->second.second = i;
        } else {
          zi::vl::vec<T,3> f1v1 = mesh.points()[mesh.faces()[it->second.first][0]];
          zi::vl::vec<T,3> f1v2 = mesh.points()[mesh.faces()[it->second.first][1]];
          zi::vl::vec<T,3> f1v3 = mesh.points()[mesh.faces()[it->second.first][2]];
          zi::vl::vec<T,3> f2v1 = mesh.points()[mesh.faces()[it->second.second][0]];
          zi::vl::vec<T,3> f2v2 = mesh.points()[mesh.faces()[it->second.second][1]];
          zi::vl::vec<T,3> f2v3 = mesh.points()[mesh.faces()[it->second.second][2]];
          zi::vl::vec<T,3> fiv1 = mesh.points()[mesh.faces()[i][0]];
          zi::vl::vec<T,3> fiv2 = mesh.points()[mesh.faces()[i][1]];
          zi::vl::vec<T,3> fiv3 = mesh.points()[mesh.faces()[i][2]];

          T area_first = zi::vl::sqrlen(zi::vl::cross(f1v2 - f1v1, f1v3 - f1v1));
          T area_second = zi::vl::sqrlen(zi::vl::cross(f2v2 - f2v1, f2v3 - f2v1));
          T area_new = zi::vl::sqrlen(zi::vl::cross(fiv2 - fiv1, fiv3 - fiv1));

          if (bad_faces.find(it->second.first) != bad_faces.end() || (bad_faces.find(i) == bad_faces.end() && area_first <= area_new && area_first <= area_second)) {
            bad_faces.insert(it->second.first);
            it->second.first = i;
          } else if (bad_faces.find(it->second.second) != bad_faces.end() || (bad_faces.find(i) == bad_faces.end() && area_second <= area_new && area_second <= area_first)) {
            bad_faces.insert(it->second.second);
            it->second.second = i;
          } else {
            bad_faces.insert(i);
          }
        }
      }
    }
  }

  for (auto rit = bad_faces.rbegin(); rit != bad_faces.rend(); ++rit) {
    mesh.faces().erase(mesh.faces().begin() + *rit); // inefficient, but we don't expect many faces to be removed
  }

  return bad_faces.size();
}

void cMesher::mesh(const std::vector<unsigned int> &data,
                    unsigned int sx, unsigned int sy, unsigned int sz)
{
  const unsigned int* a = &data[0];

  // Run global marching cubes, a mesh is generated for each segment ID group
  this->mc.marche(a, sx, sy, sz);
}

std::vector<unsigned int> cMesher::ids() {

  std::vector<unsigned int> keys;
  for ( auto it= this->mc.meshes().begin(); it != this->mc.meshes().end(); ++it )
    keys.push_back(it->first);

  return keys;
}

bool cMesher::write_obj(const unsigned int id, const std::string &filename) {
  zi::mesh::int_mesh im;
  im.add(mc.get_triangles(id));
  im.fill_simplifier<double>(s);
  s.prepare(true);

  WriteObj(s, filename);

  return true;
}

meshobj cMesher::get_mesh(const unsigned int id, const bool generate_normals, const int simplification_factor, const int max_simplification_error) {
  meshobj obj;

  if (mc.count(id) == 0) { // MC produces no triangles if either none or all voxels were labeled!
    return obj;
  }

  zi::mesh::int_mesh im;
  im.add(mc.get_triangles(id));
  im.fill_simplifier<double>(s);
  s.prepare(generate_normals);

  if (simplification_factor > 0) {
    s.optimize(s.face_count() / simplification_factor, max_simplification_error); // this is the most cpu intensive line
  }

  std::vector<zi::vl::vec3d> points;
  std::vector<zi::vl::vec3d> normals;
  std::vector<zi::vl::vec<unsigned, 3> > faces;

  s.get_faces(points, normals, faces);
  obj.points.reserve(3 * points.size());
  obj.faces.reserve(3 * faces.size());

  if (generate_normals) {
    obj.normals.reserve(3 * points.size());
  }
  else {
    obj.normals.reserve(1); 
  }

  for (auto v = points.begin(); v != points.end(); ++v) {
    obj.points.push_back((*v)[2]);
    obj.points.push_back((*v)[1]);
    obj.points.push_back((*v)[0]);
  }

  if (generate_normals) {
    for (auto vn = normals.begin(); vn != normals.end(); ++vn) {
      obj.normals.push_back((*vn)[2]);
      obj.normals.push_back((*vn)[1]);
      obj.normals.push_back((*vn)[0]);
    }
  }

  for (auto f = faces.begin(); f != faces.end(); ++f) {
    obj.faces.push_back((*f)[0]);
    obj.faces.push_back((*f)[2]);
    obj.faces.push_back((*f)[1]);
  }

  return obj;
}

// Expects Precomputed format (Indexed mesh: first 4 Byte for vertex count, then vertex positions, then triangle indices)
meshobj cMesher::merge_meshes(const std::vector<unsigned int> &entry_points, const std::vector<unsigned char> &data, bool generate_normals, int simplification_factor, int max_simplification_error) {
  meshobj obj;
  const unsigned char tri_face = 3;
  zi::mesh::face_mesh<float> merged_mesh;
  for (int i = 0; i < entry_points.size(); ++i) {
    size_t start = entry_points[i];
    size_t end = (i == entry_points.size() - 1) ? data.size() : entry_points[i+1];

    unsigned int v_cnt = *((unsigned int *)(&(data[start])));

    size_t vstart = start + sizeof(unsigned int);
    size_t fstart = vstart + 3 * sizeof(float) * v_cnt;
    unsigned int f_cnt = (unsigned int)((end - fstart) / (3 * sizeof(unsigned int)));

    const zi::vl::vec<float, 3> *p = (const zi::vl::vec<float, 3> *)(&(data[vstart]));
    const zi::vl::vec<uint32_t, 3> *f = (const zi::vl::vec<uint32_t, 3> *)(&(data[fstart]));

    zi::vl::vec<float, 3> *n = new zi::vl::vec<float, 3>[v_cnt];
    calc_normals(n, p, v_cnt, f, f_cnt);

    merged_mesh.add(p, n, v_cnt, f, f_cnt);
    delete[] n;
  }

  unsigned deleted_faces = make_manifold(merged_mesh);
  std::cout << "Removed " << deleted_faces << " triangles due to non-manifold edges.\n";

  merged_mesh.fill_simplifier<double>(s);
  s.prepare(generate_normals);

  if (simplification_factor > 0) {
    s.optimize(s.face_count() / simplification_factor, max_simplification_error); // this is the most cpu intensive line
  }

  std::vector<zi::vl::vec3d> points;
  std::vector<zi::vl::vec3d> normals;
  std::vector<zi::vl::vec<unsigned, 3> > faces;

  s.get_faces(points, normals, faces);
  obj.points.reserve(3 * points.size());
  obj.faces.reserve(3 * faces.size());

  if (generate_normals) {
    obj.normals.reserve(3 * points.size());
  }
  else {
    obj.normals.reserve(1); 
  }

  for (auto v = points.begin(); v != points.end(); ++v) {
    obj.points.push_back((*v)[2]);
    obj.points.push_back((*v)[1]);
    obj.points.push_back((*v)[0]);
  }

  if (generate_normals) {
    for (auto vn = normals.begin(); vn != normals.end(); ++vn) {
      obj.normals.push_back((*vn)[2]);
      obj.normals.push_back((*vn)[1]);
      obj.normals.push_back((*vn)[0]);
    }
  }

  for (auto f = faces.begin(); f != faces.end(); ++f) {
    obj.faces.push_back((*f)[0]);
    obj.faces.push_back((*f)[2]);
    obj.faces.push_back((*f)[1]);
  }

  return obj;
}
